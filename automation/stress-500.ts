// 500 independent, mutually-exclusive raffle draws on the validator — the full product flow:
//   creator-fee-funded random stock buy → fund the pot → snapshot ALL $SOLUM holders (weighted by
//   holdings) → VRF draw → auto-pay the proven winner. Every draw is verified on-chain, and a
//   fairness report at the end shows each holder's win rate vs. their share of tickets.
//
// Reuses one jackpot + a fixed holder pool across 500 independent epochs (each epoch is its own
// snapshot, pot, randomness and winner). Local validator + injected VRF randomness (devnet-vrf);
// the on-chain instructions are identical to production.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, mintTo,
  createAssociatedTokenAccount, getAssociatedTokenAddressSync, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { buildSnapshot } from "./twab";
import { commitEpoch, settleDevnet, winningTicketOf, payWinner, JackpotRefs } from "./draw";

const CP = TOKEN_PROGRAM_ID, RP = TOKEN_2022_PROGRAM_ID, DEC = 6, SCALE = 10n ** 6n;
const RUNS = Number(process.env.RUNS || 500);
const HOLDERS = Number(process.env.HOLDERS || 16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bal = async (conn: any, ata: PublicKey) => Number((await getAccount(conn, ata, undefined, RP)).amount);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer; // creator + snapshotter + payer
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);

  console.log(`Setting up: ${HOLDERS} holders, 1 jackpot, ${RUNS} independent draws…`);
  const coin = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, CP);
  const stock = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, RP); // the tokenized stock
  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), ops.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const pot = await createAssociatedTokenAccount(conn, ops, stock, jAuth, {}, RP, undefined, true);
  await prog.methods.initJackpot(new anchor.BN(1)).accounts({
    admin: ops.publicKey, coinMint: coin, prizeMint: stock, snapshotter: ops.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody: pot, systemProgram: SystemProgram.programId,
  }).rpc();
  const refs: JackpotRefs = { jackpot, jackpotAuthority: jAuth, prizeMint: stock, potCustody: pot, prizeTokenProgram: RP };

  // the full holder pool (all $SOLUM holders considered every draw); pre-make each one's stock ATA
  const holders = [] as { kp: Keypair; ata: PublicKey }[];
  for (let i = 0; i < HOLDERS; i++) {
    const kp = Keypair.generate();
    const ata = await createAssociatedTokenAccount(conn, ops, stock, kp.publicKey, {}, RP);
    holders.push({ kp, ata });
  }

  const wins: Record<string, number> = {}, ticketTotals: Record<string, bigint> = {};
  holders.forEach((h) => { wins[h.kp.publicKey.toBase58()] = 0; ticketTotals[h.kp.publicKey.toBase58()] = 0n; });
  let pass = 0, feesSol = 0, potPaid = 0;
  const fails: string[] = [];
  const t0 = Date.now();

  for (let r = 0; r < RUNS; r++) {
    // 1. creator fees → random stock buy → fund the pot
    const solFee = 0.05 + Math.random() * Math.random() * 8; // this hour's creator fees
    const potAmt = 60 + Math.floor(solFee * (40 + Math.random() * 60)); // stock bought with them
    feesSol += solFee;
    await mintTo(conn, ops, stock, pot, ops, potAmt, [], undefined, RP);

    // 2. snapshot ALL holders, weighted by holdings (TWAB); some hold 0 this hour → no tickets
    const twab = new Map<string, bigint>();
    for (const h of holders) {
      if (Math.random() < 0.72) twab.set(h.kp.publicKey.toBase58(), BigInt(1 + Math.floor(Math.random() * 1000)) * SCALE);
    }
    if (twab.size < 2) { for (const h of holders.slice(0, 2)) twab.set(h.kp.publicKey.toBase58(), BigInt(1 + Math.floor(Math.random() * 500)) * SCALE); }
    const snap = buildSnapshot(twab, DEC);
    for (const e of snap.entries) ticketTotals[e.owner.toBase58()] += e.tickets;

    // 3. commit → 4. VRF draw → 5. auto-pay the winner
    await commitEpoch(prog, ops, refs, snap);
    // settle once the on-chain epoch has elapsed; the local validator's clock can lag wall time,
    // so retry rather than trust a fixed sleep (fresh CSPRNG randomness each attempt = the VRF value)
    for (let attempt = 0; ; attempt++) {
      await sleep(600);
      try { await settleDevnet(prog, ops, refs); break; }
      catch (e: any) { if (String(e).includes("EpochNotElapsed") && attempt < 40) continue; throw e; }
    }
    const wt = await winningTicketOf(prog, refs);

    const winnerEntry = snap.entries.find((e) => wt >= e.start && wt < e.start + e.tickets)!;
    const wKey = winnerEntry.owner.toBase58();
    const wAta = getAssociatedTokenAddressSync(stock, winnerEntry.owner, false, RP);
    const before = await bal(conn, wAta);
    const { winner } = await payWinner(prog, ops, refs, snap, wt, conn);

    // 6. verify: the winner is a real holder with tickets, got the whole pot, pot drained to zero
    const after = await bal(conn, wAta), potLeft = await bal(conn, pot);
    const ok = winner.equals(winnerEntry.owner)
      && twab.has(wKey) && winnerEntry.tickets > 0n
      && after === before + potAmt && potLeft === 0;
    if (ok) { pass++; wins[wKey]++; potPaid += potAmt; }
    else fails.push(`run ${r}: winner=${wKey.slice(0, 6)} tkt=${wt} pot=${potAmt} paid=${after - before} left=${potLeft}`);

    if ((r + 1) % 25 === 0) process.stdout.write(`  … ${r + 1}/${RUNS} draws · ${pass} verified · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
  }

  // fairness report: win rate vs. share of all tickets ever held
  const grand = Object.values(ticketTotals).reduce((a, b) => a + b, 0n);
  console.log(`\n=== fairness: win rate vs. ticket share (${RUNS} draws) ===`);
  console.log("  holder      tickets%   won   win%    (expected ≈ tickets%)");
  const rows = holders.map((h) => {
    const k = h.kp.publicKey.toBase58();
    const share = grand > 0n ? Number((ticketTotals[k] * 10000n) / grand) / 100 : 0;
    return { k, share, won: wins[k], winPct: (wins[k] / RUNS) * 100 };
  }).sort((a, b) => b.share - a.share);
  for (const x of rows) console.log(`  ${x.k.slice(0, 6)}…   ${x.share.toFixed(2).padStart(6)}%   ${String(x.won).padStart(4)}   ${x.winPct.toFixed(2).padStart(6)}%`);

  // invariants that must hold
  const zeroTicketWinner = rows.some((x) => x.share === 0 && x.won > 0);
  console.log(`\n=== SUMMARY ===`);
  console.log(`  draws verified:            ${pass}/${RUNS}`);
  console.log(`  creator fees simulated:    ${feesSol.toFixed(2)} SOL`);
  console.log(`  stock paid out to winners: ${potPaid.toLocaleString()} base units`);
  console.log(`  a zero-ticket holder won:  ${zeroTicketWinner ? "YES ❌" : "no ✓"}`);
  if (fails.length) { console.log(`  FAILURES (${fails.length}):`); fails.slice(0, 10).forEach((f) => console.log("   - " + f)); }
  console.log(pass === RUNS && !zeroTicketWinner ? `\n✅ ALL ${RUNS} DRAWS VERIFIED — fee-funded pot, all holders weighted, VRF winner always the in-range holder, pot always fully paid.` : `\n❌ CAMPAIGN FAILED`);
  if (pass !== RUNS || zeroTicketWinner) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
