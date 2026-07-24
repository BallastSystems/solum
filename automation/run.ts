// Solum draw bot — the hourly loop that runs the raffle end to end, fairly and un-gameably.
//
//   • continuously tracks every $SOLUM holder's balance over time (TWAB → un-gameable odds)
//   • each hour: collect creator fees → buy tokenized stock → fund the pot
//   • takes the SNAPSHOT at a RANDOM, unannounced time in the hour (commit the TWAB Merkle root)
//   • picks a RANDOM draw time after that, and at it settles via Switchboard VRF → pays the winner
//   • publishes status.json each phase so the site can announce it live, and the full snapshot so
//     anyone can recompute the root from on-chain history
//
// Both random times are chosen server-side and never revealed early, so no one can time a buy;
// TWAB means a last-second buy wouldn't help anyway; VRF means the winner can't be rigged.
// Devnet-only, pre-audit. Needs a live RPC (+ pump.fun/Jupiter for funding). Config via env.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAccount, getMint } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { TwabAccumulator, buildSnapshot, winnerOf } from "./twab";
import { commitEpoch, settleDevnet, requestDrawVrf, settleDrawVrf, loadSwitchboardQueue, winningTicketOf, JackpotRefs } from "./draw";
import { fundHourly } from "./fees";
import { getAccruedCreatorFees } from "./creator-fees";
import { writeStatus, appendWinner, iso, hourLabel, feeLedger, WinnerEntry } from "./status";

// The five tokenized stocks, raffled one per hour on rotation. Each has its own mint + ops token
// account; the bot buys the hour's stock and holds it in that account for manual delivery.
const DEFAULT_ROTATION = ["AAPLx", "NVDAx", "TSLAx", "COINx", "MSTRx"];
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (unixSec: number) => sleep(Math.max(0, (unixSec - now()) * 1000));
const rint = (a: number, b: number) => a + Math.floor(Math.random() * (b - a)); // random draw/snapshot offset

// One tokenized stock in the rotation: its mint, the ops token account holding the bought stock for
// manual delivery, and its token program (Sunrise xStocks are Token-2022).
type StockCfg = { mint: PublicKey; opsAccount: PublicKey; tokenProgram: PublicKey };

type Cfg = {
  rpc: string;
  coinMint: PublicKey; // $SOLUM
  coinDecimals: number;
  vrf: "devnet" | "switchboard"; // randomness source: injected (local/devnet) vs Switchboard On-Demand
  stocks: Record<string, StockCfg>; // label → config for every rotated stock
  rotation: string[]; // hourly order, e.g. ["AAPLx","NVDAx",...]
  ops: Keypair; // creator + snapshotter + payer
  refs: JackpotRefs;
  prog: any;
  statusFile: string; // published as solum.work/status.json
  winnersFile: string; // published as solum.work/winners.json
  snapshotDir: string;
  epochLenSec: number; // on-chain min elapsed before a draw may settle
  snapMinSec: number;
  snapMaxSec: number; // snapshot fires at a random point in [snapMin, snapMax] of the hour
  countdownSec: number; // FIXED snapshot → draw countdown (5 min = 300s)
  feePollSec: number; // how often to refresh the live creator-fee pot while collecting
  feeStateFile: string; // persists the all-time creator fees CLAIMED, so the lifetime figure survives restarts
  solPriceUsd: number; // rough, for the displayed pot figure
};

/** Track live balances of every $SOLUM holder into the current epoch's TWAB accumulator. */
function trackBalances(conn: Connection, coinMint: PublicKey, twab: TwabAccumulator) {
  // SPL token accounts are 165 bytes; mint at offset 0, owner at 32, amount (u64 LE) at 64.
  return conn.onProgramAccountChange(
    TOKEN_PROGRAM_ID,
    (info) => {
      const d = info.accountInfo.data;
      twab.update(new PublicKey(d.subarray(32, 64)).toBase58(), d.readBigUInt64LE(64), now());
    },
    "confirmed",
    [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: coinMint.toBase58() } }],
  );
}

async function seedInitialBalances(conn: Connection, coinMint: PublicKey, twab: TwabAccumulator, t: number) {
  const accts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: coinMint.toBase58() } }],
  });
  for (const a of accts) {
    const d = a.account.data as Buffer;
    twab.update(new PublicKey(d.subarray(32, 64)).toBase58(), d.readBigUInt64LE(64), t);
  }
}

export async function runForever(cfg: Cfg) {
  const conn = new Connection(cfg.rpc, "confirmed");
  let sbQueue: any = null; // cached Switchboard queue (loaded once, on the switchboard path)

  // Real all-time creator fees = everything CLAIMED (swept + bought) over time + what's currently accrued.
  // Persisted so the lifetime figure survives restarts (start the bot near launch for a full total).
  let feesClaimedSol = 0;
  try { feesClaimedSol = JSON.parse(fs.readFileSync(cfg.feeStateFile, "utf8")).feesClaimedSol || 0; } catch { /* first run */ }
  const saveFeeState = () => { try { fs.mkdirSync(path.dirname(cfg.feeStateFile), { recursive: true }); fs.writeFileSync(cfg.feeStateFile, JSON.stringify({ feesClaimedSol }, null, 2)); } catch { /* best-effort */ } };
  const lifetimeUsd = (accruedSol: number) => Math.round((feesClaimedSol + accruedSol) * cfg.solPriceUsd);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const hourStart = now();
    const label = hourLabel(hourStart);
    const twab = new TwabAccumulator(hourStart);
    await seedInitialBalances(conn, cfg.coinMint, twab, hourStart);
    const sub = trackBalances(conn, cfg.coinMint, twab);
    let potUsd = 0, accruedSol = 0;

    const collecting = () => writeStatus(cfg.statusFile, {
      hourLabel: label, phase: "collecting", snapshotAt: null, drawAt: null, holders: 0, potUsd, prize: null,
      ...feeLedger(cfg.winnersFile, potUsd), feesLifetimeUsd: lifetimeUsd(accruedSol), lastWinner: null,
    });

    // choose a RANDOM, hidden snapshot time; until it fires, just track the creator fees accruing live
    const snapAt = hourStart + rint(cfg.snapMinSec, cfg.snapMaxSec);
    collecting();
    console.log(`[hour ${label}] snapshot scheduled (hidden) · tracking creator fees`);
    while (now() < snapAt) {
      try { accruedSol = (await getAccruedCreatorFees(conn, cfg.ops.publicKey)) / 1e9; potUsd = Math.round(accruedSol * cfg.solPriceUsd); collecting(); } catch { /* keep last value */ }
      await sleep(Math.max(1000, Math.min(cfg.feePollSec * 1000, (snapAt - now()) * 1000)));
    }

    let drawAt = 0, winnerAddr = "", holders = 0, stockLabel = cfg.rotation[0], prizeShares = 0, prizeBaseUnits = "0";
    try {
      // SNAPSHOT: freeze the TWAB into ticket ranges + Merkle root, commit on-chain
      const snap = buildSnapshot(twab.finalize(now()), cfg.coinDecimals);
      holders = snap.entries.length;
      await commitEpoch(cfg.prog, cfg.ops, cfg.refs, snap);
      fs.mkdirSync(cfg.snapshotDir, { recursive: true });
      fs.writeFileSync(`${cfg.snapshotDir}/epoch-${hourStart}.json`, JSON.stringify({
        hourStart, snapshotAt: iso(now()), total: snap.total.toString(), root: snap.root.toString("hex"),
        entries: snap.entries.map((e) => ({ owner: e.owner.toBase58(), start: e.start.toString(), tickets: e.tickets.toString() })),
      }, null, 2));

      // BUY THE PRIZE at the snapshot: ONE stock chosen AT RANDOM, bought with the FULL cycle's
      // creator fees (claim + Jupiter swap), then held in the dev wallet for manual delivery.
      stockLabel = cfg.rotation[Math.floor(Math.random() * cfg.rotation.length)];
      const stk = cfg.stocks[stockLabel];
      try {
        if (!stk) throw new Error(`no config for ${stockLabel}`);
        const f = await fundHourly(conn, cfg.ops, stk.mint, stk.opsAccount, cfg.refs.potCustody, stk.tokenProgram);
        prizeBaseUnits = f.stockBought.toString();
        if (f.solCollected > 0) { potUsd = Math.round(f.solCollected * cfg.solPriceUsd); feesClaimedSol += f.solCollected; saveFeeState(); } // reconcile + fold into all-time claimed
        accruedSol = 0; // the creator vault was just swept by the claim
        const dec = (await getMint(conn, stk.mint, undefined, stk.tokenProgram)).decimals;
        prizeShares = Number(f.stockBought) / 10 ** dec;
        console.log(`[snapshot ${label}] bought ${prizeShares} ${stockLabel} (~$${potUsd}) for this draw`);
      } catch (e: any) { console.error("[buy] skipped:", e.message); }

      // FIXED 5-minute countdown to the draw — announced the instant the snapshot is taken
      drawAt = now() + cfg.countdownSec;
      const prize = { stock: stockLabel, shares: prizeShares, usd: potUsd };
      writeStatus(cfg.statusFile, {
        hourLabel: label, phase: "snapshot_taken", snapshotAt: iso(snapAt), drawAt: iso(drawAt), holders, potUsd, prize,
        ...feeLedger(cfg.winnersFile, potUsd), feesLifetimeUsd: lifetimeUsd(accruedSol), lastWinner: null,
      });
      console.log(`[snapshot ${label}] taken · ${holders} holders · ${stockLabel} prize · drawing in ${cfg.countdownSec}s`);
      await sleepUntil(drawAt);

      // DRAW: VRF settle fixes the winner on-chain. We do NOT pay from here — the prize is held in
      // the review (ops) wallet for a 24h quality-control period, then sent to the winner when they
      // claim. So this records a *pending claim*; a separate release step fulfils it after the hold.
      if (cfg.vrf === "switchboard") {
        // production: commit + bind a Switchboard On-Demand randomness account, then reveal + settle
        sbQueue = sbQueue || (await loadSwitchboardQueue(conn));
        const rnd = await requestDrawVrf(cfg.prog, sbQueue, cfg.ops, cfg.refs, conn);
        await settleDrawVrf(cfg.prog, rnd, cfg.ops, cfg.refs, conn);
      } else {
        await settleDevnet(cfg.prog, cfg.ops, cfg.refs); // local/devnet: injected randomness
      }
      const wt = await winningTicketOf(cfg.prog, cfg.refs);
      // the prize = the stock already bought at the snapshot (stockLabel / prizeShares / prizeBaseUnits)
      const { entry } = winnerOf(snap, wt); // who the VRF drew — proven on-chain
      winnerAddr = entry.owner.toBase58();
      // The winner can Claim right away; claiming starts a 24h window in which the operator delivers.
      const winRow: WinnerEntry = {
        epoch: Math.floor(hourStart / 3600), hourLabel: label, addr: winnerAddr,
        solumHeld: Number(entry.tickets), totalTickets: Number(snap.total), holders,
        stock: stockLabel, prizeShares, prizeBaseUnits, prizeUsd: potUsd, drawAt: iso(drawAt),
        claimed: false, claimedAt: null, awarded: false, awardTx: null, payoutTx: "",
      };
      writeStatus(cfg.statusFile, {
        hourLabel: label, phase: "drawn", snapshotAt: iso(snapAt), drawAt: iso(drawAt), holders, potUsd,
        prize: { stock: stockLabel, shares: prizeShares, usd: potUsd },
        ...feeLedger(cfg.winnersFile, potUsd), feesLifetimeUsd: lifetimeUsd(accruedSol),
        lastWinner: { addr: winnerAddr, prizeUsd: potUsd, stock: stockLabel, drawAt: iso(drawAt) },
      });
      appendWinner(cfg.winnersFile, winRow); // publishes winners.json for the site's winners register
      console.log(`[draw ${label}] ticket ${wt} · winner ${winnerAddr} won ~$${potUsd} ${stockLabel} · claimable now, deliver after the 24h`);
    } catch (e: any) {
      console.error("[draw] failed:", e.message);
    } finally {
      await conn.removeProgramAccountChangeListener(sub);
    }
  }
}

if (require.main === module) {
  const rpc = process.env.SOLUM_RPC || "https://api.devnet.solana.com";
  const ops = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SOLUM_OPS_KEY!, "utf8"))));
  const idl = JSON.parse(fs.readFileSync(process.env.SOLUM_IDL || "target/idl/solum.json", "utf8"));
  const provider = new anchor.AnchorProvider(new Connection(rpc, "confirmed"), new anchor.Wallet(ops), {});
  const prog = new anchor.Program(idl, provider);
  const coinMint = new PublicKey(process.env.SOLUM_COIN_MINT!);
  const admin = new PublicKey(process.env.SOLUM_ADMIN!);
  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coinMint.toBuffer(), admin.toBuffer()], prog.programId);
  const [jackpotAuthority] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  // SOLUM_STOCKS: JSON map of all rotated stocks, e.g.
  //   {"AAPLx":{"mint":"..","opsAccount":"..","tokenProgram":"Tokenz.."},"NVDAx":{...}, ...}
  // Falls back to the single SOLUM_STOCK_* vars (one-stock config) when SOLUM_STOCKS is unset.
  const stockProgram = process.env.SOLUM_STOCK_PROGRAM || "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  const stocks: Record<string, StockCfg> = {};
  if (process.env.SOLUM_STOCKS) {
    const raw = JSON.parse(process.env.SOLUM_STOCKS) as Record<string, { mint: string; opsAccount: string; tokenProgram?: string }>;
    for (const [label, v] of Object.entries(raw))
      stocks[label] = { mint: new PublicKey(v.mint), opsAccount: new PublicKey(v.opsAccount), tokenProgram: new PublicKey(v.tokenProgram || stockProgram) };
  } else {
    const label = process.env.SOLUM_STOCK_LABEL || "AAPLx";
    stocks[label] = { mint: new PublicKey(process.env.SOLUM_STOCK_MINT!), opsAccount: new PublicKey(process.env.SOLUM_OPS_STOCK_ACCT!), tokenProgram: new PublicKey(stockProgram) };
  }
  const rotation = (process.env.SOLUM_ROTATION ? process.env.SOLUM_ROTATION.split(",") : DEFAULT_ROTATION).filter((l) => stocks[l]);
  if (rotation.length === 0) throw new Error("no rotated stocks configured (set SOLUM_STOCKS or SOLUM_STOCK_MINT)");
  const firstStock = stocks[rotation[0]];
  runForever({
    rpc, coinMint, coinDecimals: Number(process.env.SOLUM_COIN_DECIMALS || 6),
    vrf: process.env.SOLUM_VRF === "switchboard" ? "switchboard" : "devnet",
    stocks, rotation, ops, prog,
    refs: { jackpot, jackpotAuthority, prizeMint: firstStock.mint, potCustody: new PublicKey(process.env.SOLUM_POT_CUSTODY!), prizeTokenProgram: firstStock.tokenProgram },
    statusFile: process.env.SOLUM_STATUS_FILE || "public/status.json",
    winnersFile: process.env.SOLUM_WINNERS_FILE || "public/winners.json",
    snapshotDir: process.env.SOLUM_SNAPSHOT_DIR || "snapshots",
    feeStateFile: process.env.SOLUM_FEE_STATE || "automation/fee-state.json",
    epochLenSec: Number(process.env.SOLUM_EPOCH_LEN || 60),
    snapMinSec: Number(process.env.SOLUM_SNAP_MIN || 8 * 60),
    snapMaxSec: Number(process.env.SOLUM_SNAP_MAX || 50 * 60),
    countdownSec: Number(process.env.SOLUM_COUNTDOWN || 5 * 60),
    feePollSec: Number(process.env.SOLUM_FEE_POLL || 20),
    solPriceUsd: Number(process.env.SOLUM_SOL_PRICE || 150),
  }).catch((e) => { console.error(e); process.exit(1); });
}
