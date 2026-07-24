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
import { TwabAccumulator, buildSnapshot, winnerOf } from "./twab";
import { commitEpoch, settleDevnet, requestDrawVrf, settleDrawVrf, loadSwitchboardQueue, winningTicketOf, JackpotRefs } from "./draw";
import { fundHourly, randomBuyTimes } from "./fees";
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
  drawGapMinSec: number;
  drawGapMaxSec: number; // draw fires a random gap after the snapshot
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const hourStart = now();
    const label = hourLabel(hourStart);
    const stockLabel = cfg.rotation[Math.floor(hourStart / 3600) % cfg.rotation.length]; // this hour's stock, on rotation
    const stk = cfg.stocks[stockLabel]; // its mint + ops account + token program
    const twab = new TwabAccumulator(hourStart);
    await seedInitialBalances(conn, cfg.coinMint, twab, hourStart);
    const sub = trackBalances(conn, cfg.coinMint, twab);
    let potUsd = 0, hourStockBought = 0n;

    const collecting = () => writeStatus(cfg.statusFile, {
      hourLabel: label, phase: "collecting", snapshotAt: null, drawAt: null, holders: 0, potUsd, ...feeLedger(cfg.winnersFile, potUsd), lastWinner: null,
    });

    // choose a RANDOM snapshot time this hour — hidden from everyone until it fires
    const snapAt = hourStart + rint(cfg.snapMinSec, cfg.snapMaxSec);
    collecting();
    console.log(`[hour ${label}] snapshot scheduled (hidden) · buying ${stockLabel} at random moments`);

    // Collect creator fees → buy THIS hour's tokenized stock at a few UNPREDICTABLE moments in the
    // collecting window (so buys can't be front-run), held in the review (ops) wallet for the winner.
    const buyWindow = Math.max(60, snapAt - hourStart - 30);
    for (const off of randomBuyTimes(buyWindow, 1 + Math.floor(Math.random() * 3))) {
      await sleepUntil(hourStart + off);
      try {
        if (!stk) throw new Error(`no config for rotated stock ${stockLabel}`);
        const f = await fundHourly(conn, cfg.ops, stk.mint, stk.opsAccount, cfg.refs.potCustody, stk.tokenProgram);
        if (f.stockBought > 0n) {
          hourStockBought += f.stockBought; // accumulates the hour's prize (base units)
          potUsd += Math.round(f.solCollected * cfg.solPriceUsd);
          console.log(`[fund] +${f.solCollected} SOL → ${f.stockBought} ${stockLabel} (pot ~$${potUsd})`);
          collecting(); // reflect the growing pot live
        }
      } catch (e: any) {
        console.error("[fund] skipped:", e.message);
      }
    }
    await sleepUntil(snapAt);

    let drawAt = 0, winnerAddr = "", holders = 0;
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

      // now the snapshot is locked, reveal a RANDOM draw time (>= the on-chain min elapsed)
      drawAt = now() + Math.max(cfg.epochLenSec + 15, rint(cfg.drawGapMinSec, cfg.drawGapMaxSec));
      writeStatus(cfg.statusFile, {
        hourLabel: label, phase: "snapshot_taken", snapshotAt: iso(snapAt), drawAt: iso(drawAt), holders, potUsd, ...feeLedger(cfg.winnersFile, potUsd), lastWinner: null,
      });
      console.log(`[snapshot ${label}] taken · ${holders} holders · drawing at ${new Date(drawAt * 1000).toLocaleTimeString()}`);
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
      // the prize for this epoch = the stock bought from this hour's fees, held in the review wallet
      let prizeShares = 0;
      const prizeBaseUnits = hourStockBought.toString();
      try {
        const dec = (await getMint(conn, stk.mint, undefined, stk.tokenProgram)).decimals;
        prizeShares = Number(hourStockBought) / 10 ** dec;
      } catch { /* leave prizeShares 0; the site falls back to a price estimate */ }
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
        ...feeLedger(cfg.winnersFile, potUsd),
        lastWinner: { addr: winnerAddr, prizeUsd: potUsd, stock: stockLabel, drawAt: iso(drawAt) },
      });
      appendWinner(cfg.winnersFile, winRow); // publishes winners.json for the site's winners register
      console.log(`[draw ${label}] ticket ${wt} · winner ${winnerAddr} won ~$${potUsd} ${stockLabel} · claimable now, deliver within 24h`);
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
    epochLenSec: Number(process.env.SOLUM_EPOCH_LEN || 60),
    snapMinSec: Number(process.env.SOLUM_SNAP_MIN || 8 * 60),
    snapMaxSec: Number(process.env.SOLUM_SNAP_MAX || 50 * 60),
    drawGapMinSec: Number(process.env.SOLUM_DRAW_GAP_MIN || 3 * 60),
    drawGapMaxSec: Number(process.env.SOLUM_DRAW_GAP_MAX || 9 * 60),
    solPriceUsd: Number(process.env.SOLUM_SOL_PRICE || 150),
  }).catch((e) => { console.error(e); process.exit(1); });
}
