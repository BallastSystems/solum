// Standalone adversarial runner for the no-loss real-stock jackpot.
//
// Proves the full draw end-to-end on a validator: a snapshotter commits a TWAB Merkle root; the
// draw settles from injected randomness (devnet-vrf) once the epoch elapses; the holder whose
// ticket range contains the winning ticket claims the whole pot; and every abuse reverts —
// claim-before-settle, settle-before-epoch-elapsed, re-commit while busy, a wrong Merkle proof, a
// non-winning holder, and a double claim.
//
// The coin is classic SPL (like a pump.fun launch); the prize is Token-2022 (like an xStock).
// The Merkle tree is built here with the SAME hashing the program uses (keccak256, 0x00 leaf /
// 0x01 sorted-node domain tags) so the off-chain snapshotter and on-chain verifier agree.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createMint, mintTo, createAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";
import * as fs from "fs";
import * as path from "path";

const CP = TOKEN_PROGRAM_ID;      // coin: classic SPL
const RP = TOKEN_2022_PROGRAM_ID; // prize: Token-2022

// ---- Merkle (must mirror the on-chain hash_leaf / hash_node exactly) ----
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const hashLeaf = (owner: PublicKey, start: bigint, tickets: bigint): Buffer =>
  Buffer.from(keccak_256(Buffer.concat([Buffer.from([0]), owner.toBuffer(), u64le(start), u64le(tickets)])));
const hashNode = (a: Buffer, b: Buffer): Buffer => {
  const [x, y] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak_256(Buffer.concat([Buffer.from([1]), x, y])));
};
function buildTree(leaves: Buffer[]) {
  const layers: Buffer[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1], next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2)
      next.push(i + 1 < cur.length ? hashNode(cur[i], cur[i + 1]) : cur[i]); // promote odd
    layers.push(next);
  }
  return layers;
}
function proofFor(layers: Buffer[][], index: number): Buffer[] {
  const p: Buffer[] = []; let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l], sib = idx ^ 1;
    if (sib < layer.length) p.push(layer[sib]);
    idx = Math.floor(idx / 2);
  }
  return p;
}
const arr = (b: Buffer) => Array.from(b);

type Case = { name: string; ok: boolean; detail?: string };
const results: Case[] = [];
const check = (name: string, cond: boolean, detail?: string) =>
  results.push({ name, ok: cond, detail: cond ? undefined : detail });
async function expectRevert(name: string, sub: string, fn: () => Promise<any>) {
  try { await fn(); results.push({ name, ok: false, detail: `expected revert "${sub}", succeeded` }); }
  catch (e: any) {
    const s = e.toString() + (e.logs ? "\n" + e.logs.join("\n") : "");
    results.push({ name, ok: s.includes(sub), detail: s.includes(sub) ? undefined : s.slice(0, 220) });
  }
}
const bal = async (conn: any, ata: PublicKey, prog: PublicKey) =>
  Number((await getAccount(conn, ata, undefined, prog)).amount);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer; // admin + snapshotter
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);

  const coin = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, CP);
  const prize = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, RP);

  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), payer.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const potCustody = await createAssociatedTokenAccount(conn, payer, prize, jAuth, {}, RP, undefined, true);

  const EPOCH_LEN = 2; // seconds — short so the test can wait out the draw window
  await prog.methods.initJackpot(new anchor.BN(EPOCH_LEN)).accounts({
    admin: payer.publicKey, coinMint: coin, prizeMint: prize, snapshotter: payer.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody, systemProgram: SystemProgram.programId,
  }).rpc();
  check("init_jackpot", true);

  // fund the prize pot (creator-fee buyback of real stock)
  await mintTo(conn, payer, prize, potCustody, payer, 1000, [], undefined, RP);

  // three holders with contiguous ticket ranges (from the off-chain TWAB snapshot)
  const mk = async () => {
    const kp = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL), "confirmed");
    const prizeAta = await createAssociatedTokenAccount(conn, payer, prize, kp.publicKey, {}, RP);
    return { kp, prizeAta };
  };
  const h1 = await mk(), h2 = await mk(), h3 = await mk();
  const holders = [
    { h: h1, start: 0n, tickets: 100n }, // [0,100)
    { h: h2, start: 100n, tickets: 300n }, // [100,400)  <- winner range
    { h: h3, start: 400n, tickets: 100n }, // [400,500)
  ];
  const TOTAL = 500n;
  const leaves = holders.map(x => hashLeaf(x.h.kp.publicKey, x.start, x.tickets));
  const layers = buildTree(leaves);
  const root = layers[layers.length - 1][0];

  const commit = () => prog.methods.commitEpoch(arr(root), new anchor.BN(TOTAL.toString()))
    .accounts({ snapshotter: payer.publicKey, jackpot }).rpc();
  const settle = (rand: Buffer) => prog.methods.settleDraw(arr(rand))
    .accounts({ snapshotter: payer.publicKey, jackpot }).rpc();
  const claim = (who: any, start: bigint, tickets: bigint, proof: Buffer[]) =>
    prog.methods.claimPrize(new anchor.BN(start.toString()), new anchor.BN(tickets.toString()), proof.map(arr))
      .accounts({
        winner: who.kp.publicKey, jackpot, jackpotAuthority: jAuth, prizeMint: prize,
        potCustody, winnerPrizeAccount: who.prizeAta, prizeTokenProgram: RP,
      }).signers([who.kp]).rpc();

  // --- commit the epoch root ---
  await commit();
  check("commit_epoch opens a draw", true);

  const rand = Buffer.concat([u64le(250n), Buffer.alloc(24)]); // winning_ticket = 250 % 500 = 250

  // --- abuse before the draw is ready ---
  await expectRevert("claim before settle reverts", "JackpotNotReady",
    () => claim(holders[1].h, 100n, 300n, proofFor(layers, 1)));
  await expectRevert("settle before epoch elapsed reverts", "EpochNotElapsed",
    () => settle(rand));
  await expectRevert("re-commit while busy reverts", "JackpotBusy", () => commit());

  // --- wait out the epoch, then settle to a known winning ticket (250 -> h2's range) ---
  await new Promise(r => setTimeout(r, (EPOCH_LEN + 1) * 1000));
  await settle(rand);
  const j = await (prog.account as any).jackpotState.fetch(jackpot);
  check("settle_draw fixes winning ticket = 250", Number(j.winningTicket) === 250, `got ${j.winningTicket}`);

  // --- a non-winning holder can't claim (valid leaf, wrong range) ---
  await expectRevert("non-winner reverts (out of range)", "NotWinner",
    () => claim(holders[0].h, 0n, 100n, proofFor(layers, 0)));

  // --- a wrong Merkle proof is rejected ---
  await expectRevert("wrong proof reverts", "BadProof",
    () => claim(holders[1].h, 100n, 300n, [leaves[0]] /* garbage proof */));

  // --- the real winner claims the whole pot ---
  const before = await bal(conn, holders[1].h.prizeAta, RP);
  await claim(holders[1].h, 100n, 300n, proofFor(layers, 1));
  check("winner claims the full 1000 pot", (await bal(conn, holders[1].h.prizeAta, RP)) === before + 1000);
  check("pot custody drained to zero", (await bal(conn, potCustody, RP)) === 0);

  // --- no double claim (phase returned to Open) ---
  await expectRevert("double claim reverts", "JackpotNotReady",
    () => claim(holders[1].h, 100n, 300n, proofFor(layers, 1)));

  console.log("\n=== solum :: no-loss real-stock jackpot ===");
  let pass = 0;
  for (const r of results) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`); if (r.ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  if (pass !== results.length) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
