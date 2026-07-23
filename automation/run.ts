// Solum draw bot — the hourly loop that runs the raffle end to end.
//
//   • continuously tracks every $SOLUM holder's balance over time (for TWAB / un-gameable odds)
//   • each hour: collect creator fees → buy tokenized stock → fund the pot
//   • at a RANDOM moment inside the draw window: snapshot TWAB → commit root → settle (VRF) → pay
//   • publishes the full snapshot so anyone can recompute the root from on-chain history
//
// Devnet-only, pre-audit. Needs a live RPC (+ pump.fun/Jupiter for the funding step). Config via env.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs";
import { TwabAccumulator, buildSnapshot } from "./twab";
import { commitEpoch, settleDevnet, winningTicketOf, payWinner, JackpotRefs } from "./draw";
import { fundHourly } from "./fees";

const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo: number, hi: number) => lo + Math.random() * (hi - lo); // random draw moment

type Cfg = {
  rpc: string;
  coinMint: PublicKey; // $SOLUM
  coinDecimals: number;
  stockMint: PublicKey;
  opsStockAccount: PublicKey;
  ops: Keypair; // creator + snapshotter + payer
  refs: JackpotRefs;
  prog: any;
  drawWindowStart: number; // seconds into the hour after which a draw may fire (e.g. 3000)
};

/** Track live balances of every $SOLUM holder into the current epoch's TWAB accumulator. */
function trackBalances(conn: Connection, coinMint: PublicKey, twab: TwabAccumulator) {
  // SPL token accounts are 165 bytes; mint is at offset 0, owner at 32, amount (u64 LE) at 64.
  return conn.onProgramAccountChange(
    TOKEN_PROGRAM_ID,
    (info) => {
      const d = info.accountInfo.data;
      const owner = new PublicKey(d.subarray(32, 64)).toBase58();
      const amount = d.readBigUInt64LE(64);
      twab.update(owner, amount, now());
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
    const epochStart = now();
    const twab = new TwabAccumulator(epochStart);
    await seedInitialBalances(conn, cfg.coinMint, twab, epochStart);
    const sub = trackBalances(conn, cfg.coinMint, twab);

    // fund the pot from this hour's creator fees
    try {
      const f = await fundHourly(conn, cfg.ops, cfg.stockMint, cfg.opsStockAccount, cfg.refs.potCustody, TOKEN_PROGRAM_ID);
      console.log(`[fund] +${f.solCollected} SOL → ${f.stockBought} stock`);
    } catch (e: any) {
      console.error("[fund] skipped:", e.message);
    }

    // wait to a RANDOM moment in the draw window (unpredictable draw time)
    const drawAt = epochStart + Math.floor(jitter(cfg.drawWindowStart, HOUR));
    await sleep(Math.max(0, (drawAt - now()) * 1000));

    try {
      const snap = buildSnapshot(twab.finalize(now()), cfg.coinDecimals);
      fs.writeFileSync(
        `snapshots/epoch-${epochStart}.json`,
        JSON.stringify({ epochStart, total: snap.total.toString(), root: snap.root.toString("hex"),
          entries: snap.entries.map((e) => ({ owner: e.owner.toBase58(), start: e.start.toString(), tickets: e.tickets.toString() })) }, null, 2),
      );
      await commitEpoch(cfg.prog, cfg.ops, cfg.refs, snap);
      await settleDevnet(cfg.prog, cfg.ops, cfg.refs); // switchboard-vrf: request_draw + settle_draw
      const wt = await winningTicketOf(cfg.prog, cfg.refs);
      const { winner, tickets } = await payWinner(cfg.prog, cfg.ops, cfg.refs, snap, wt, conn);
      console.log(`[draw] epoch ${epochStart} · ticket ${wt} · winner ${winner.toBase58()} (${tickets} tickets)`);
    } catch (e: any) {
      console.error("[draw] failed:", e.message);
    } finally {
      await conn.removeProgramAccountChangeListener(sub);
    }
  }
}

// Entry point: load config from env + keypair file, then run.
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
  fs.mkdirSync("snapshots", { recursive: true });
  runForever({
    rpc, coinMint, coinDecimals: Number(process.env.SOLUM_COIN_DECIMALS || 6),
    stockMint: new PublicKey(process.env.SOLUM_STOCK_MINT!),
    opsStockAccount: new PublicKey(process.env.SOLUM_OPS_STOCK_ACCT!), ops, prog,
    refs: { jackpot, jackpotAuthority, prizeMint: new PublicKey(process.env.SOLUM_STOCK_MINT!),
      potCustody: new PublicKey(process.env.SOLUM_POT_CUSTODY!), prizeTokenProgram: new PublicKey(process.env.SOLUM_STOCK_PROGRAM!) },
    drawWindowStart: Number(process.env.SOLUM_DRAW_WINDOW_START || 3000),
  }).catch((e) => { console.error(e); process.exit(1); });
}
