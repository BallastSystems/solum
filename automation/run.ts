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
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import { TwabAccumulator, buildSnapshot } from "./twab";
import { commitEpoch, settleDevnet, winningTicketOf, payWinner, JackpotRefs } from "./draw";
import { fundHourly } from "./fees";
import { writeStatus, iso, hourLabel } from "./status";

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (unixSec: number) => sleep(Math.max(0, (unixSec - now()) * 1000));
const rint = (a: number, b: number) => a + Math.floor(Math.random() * (b - a)); // random draw/snapshot offset

type Cfg = {
  rpc: string;
  coinMint: PublicKey; // $SOLUM
  coinDecimals: number;
  stockMint: PublicKey;
  stockLabel: string; // e.g. "NVDAx"
  opsStockAccount: PublicKey;
  ops: Keypair; // creator + snapshotter + payer
  refs: JackpotRefs;
  prog: any;
  statusFile: string; // published as solum.work/status.json
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const hourStart = now();
    const label = hourLabel(hourStart);
    const twab = new TwabAccumulator(hourStart);
    await seedInitialBalances(conn, cfg.coinMint, twab, hourStart);
    const sub = trackBalances(conn, cfg.coinMint, twab);
    let potUsd = 0;

    // collect creator fees → stock → pot
    try {
      const f = await fundHourly(conn, cfg.ops, cfg.stockMint, cfg.opsStockAccount, cfg.refs.potCustody, TOKEN_PROGRAM_ID);
      potUsd = Math.round(f.solCollected * cfg.solPriceUsd);
      console.log(`[fund] +${f.solCollected} SOL → ${f.stockBought} stock (~$${potUsd})`);
    } catch (e: any) {
      console.error("[fund] skipped:", e.message);
    }

    // choose a RANDOM snapshot time this hour — hidden from everyone until it fires
    const snapAt = hourStart + rint(cfg.snapMinSec, cfg.snapMaxSec);
    writeStatus(cfg.statusFile, {
      hourLabel: label, phase: "collecting", snapshotAt: null, drawAt: null, holders: 0, potUsd, lastWinner: null,
    });
    console.log(`[hour ${label}] snapshot scheduled (hidden) · fees funding pot`);
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
        hourLabel: label, phase: "snapshot_taken", snapshotAt: iso(snapAt), drawAt: iso(drawAt), holders, potUsd, lastWinner: null,
      });
      console.log(`[snapshot ${label}] taken · ${holders} holders · drawing at ${new Date(drawAt * 1000).toLocaleTimeString()}`);
      await sleepUntil(drawAt);

      // DRAW: VRF settle → auto-pay the proven winner
      await settleDevnet(cfg.prog, cfg.ops, cfg.refs); // switchboard-vrf: request_draw + settle_draw
      const wt = await winningTicketOf(cfg.prog, cfg.refs);
      const { winner } = await payWinner(cfg.prog, cfg.ops, cfg.refs, snap, wt, conn);
      winnerAddr = winner.toBase58();
      writeStatus(cfg.statusFile, {
        hourLabel: label, phase: "drawn", snapshotAt: iso(snapAt), drawAt: iso(drawAt), holders, potUsd,
        lastWinner: { addr: winnerAddr, prizeUsd: potUsd, stock: cfg.stockLabel, drawAt: iso(drawAt) },
      });
      console.log(`[draw ${label}] ticket ${wt} · winner ${winnerAddr} won ~$${potUsd} ${cfg.stockLabel}`);
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
  const stockMint = new PublicKey(process.env.SOLUM_STOCK_MINT!);
  runForever({
    rpc, coinMint, coinDecimals: Number(process.env.SOLUM_COIN_DECIMALS || 6), stockMint,
    stockLabel: process.env.SOLUM_STOCK_LABEL || "NVDAx",
    opsStockAccount: new PublicKey(process.env.SOLUM_OPS_STOCK_ACCT!), ops, prog,
    refs: { jackpot, jackpotAuthority, prizeMint: stockMint, potCustody: new PublicKey(process.env.SOLUM_POT_CUSTODY!), prizeTokenProgram: new PublicKey(process.env.SOLUM_STOCK_PROGRAM!) },
    statusFile: process.env.SOLUM_STATUS_FILE || "public/status.json",
    snapshotDir: process.env.SOLUM_SNAPSHOT_DIR || "snapshots",
    epochLenSec: Number(process.env.SOLUM_EPOCH_LEN || 60),
    snapMinSec: Number(process.env.SOLUM_SNAP_MIN || 8 * 60),
    snapMaxSec: Number(process.env.SOLUM_SNAP_MAX || 50 * 60),
    drawGapMinSec: Number(process.env.SOLUM_DRAW_GAP_MIN || 3 * 60),
    drawGapMaxSec: Number(process.env.SOLUM_DRAW_GAP_MAX || 9 * 60),
    solPriceUsd: Number(process.env.SOLUM_SOL_PRICE || 150),
  }).catch((e) => { console.error(e); process.exit(1); });
}
