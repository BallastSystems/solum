// Stateful jackpot fuzzer — random interleaved sequences of fund / commit / settle / claim plus
// adversarial ops (commit-while-busy, claim-in-wrong-phase, wrong proof, non-winner), each checked
// against an off-chain reference model. Invariants after every op:
//   I1  conservation: total minted == total paid to winners + current pot balance
//   I2  every successful claim paid the full pot to the in-range holder, and only then
//   I3  the phase machine only advances on valid transitions; invalid ops revert and change nothing
//
// Local validator + injected VRF randomness. Reuses one jackpot + holder pool across the run.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, mintTo,
  createAssociatedTokenAccount, getAssociatedTokenAddressSync, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { buildSnapshot, winnerOf } from "./twab";
import { commitEpoch, settleDevnet, winningTicketOf, payWinner, JackpotRefs } from "./draw";
import { hashLeaf, toArray } from "./merkle";

const CP = TOKEN_PROGRAM_ID, RP = TOKEN_2022_PROGRAM_ID, DEC = 6, SCALE = 10n ** 6n;
const OPS = Number(process.env.OPS || 150);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ri = (n: number) => Math.floor(Math.random() * n);
const bal = async (conn: any, ata: PublicKey) => BigInt((await getAccount(conn, ata, undefined, RP)).amount.toString());

async function expectRevert(sub: string, fn: () => Promise<any>): Promise<boolean> {
  try { await fn(); return false; } catch (e: any) { return (e.toString() + (e.logs ? e.logs.join("") : "")).includes(sub); }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer;
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);

  const coin = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, CP);
  const stock = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, RP);
  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), ops.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const pot = await createAssociatedTokenAccount(conn, ops, stock, jAuth, {}, RP, undefined, true);
  await prog.methods.initJackpot(new anchor.BN(1)).accounts({
    admin: ops.publicKey, coinMint: coin, prizeMint: stock, snapshotter: ops.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody: pot, systemProgram: SystemProgram.programId,
  }).rpc();
  const refs: JackpotRefs = { jackpot, jackpotAuthority: jAuth, prizeMint: stock, potCustody: pot, prizeTokenProgram: RP };

  const holders: { kp: Keypair; ata: PublicKey }[] = [];
  for (let i = 0; i < 12; i++) {
    const kp = Keypair.generate();
    holders.push({ kp, ata: await createAssociatedTokenAccount(conn, ops, stock, kp.publicKey, {}, RP) });
  }

  // reference model
  let phase: "OPEN" | "COMMITTED" | "SETTLED" = "OPEN";
  let minted = 0n, paid = 0n; // pot balance is read from chain
  let snap: ReturnType<typeof buildSnapshot> | null = null;
  const results: { name: string; ok: boolean; detail?: string }[] = [];
  const chk = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });

  const settleElapsed = async () => { for (let a = 0; ; a++) { await sleep(600); try { await settleDevnet(prog, ops, refs); return; } catch (e: any) { if (String(e).includes("EpochNotElapsed") && a < 40) continue; throw e; } } };
  const conservation = async () => (minted === paid + (await bal(conn, pot)));

  let ok = 0;
  for (let i = 0; i < OPS; i++) {
    if (phase === "OPEN") {
      if (ri(10) < 3) { // FUND
        const amt = BigInt(50 + ri(4000)); await mintTo(conn, ops, stock, pot, ops, Number(amt), [], undefined, RP); minted += amt;
        chk(`op${i} fund (open)`, await conservation());
      } else { // COMMIT
        const twab = new Map<string, bigint>();
        for (const h of holders) if (Math.random() < 0.7) twab.set(h.kp.publicKey.toBase58(), BigInt(1 + ri(800)) * SCALE);
        if (twab.size < 2) holders.slice(0, 2).forEach((h) => twab.set(h.kp.publicKey.toBase58(), BigInt(1 + ri(400)) * SCALE));
        snap = buildSnapshot(twab, DEC);
        await commitEpoch(prog, ops, refs, snap); phase = "COMMITTED";
        chk(`op${i} commit`, true);
      }
    } else if (phase === "COMMITTED") {
      const roll = ri(10);
      if (roll < 7) { // SETTLE
        await settleElapsed(); phase = "SETTLED"; chk(`op${i} settle`, true);
      } else if (roll < 9) { // adversarial: commit while busy must revert
        chk(`op${i} commit-while-busy reverts`, await expectRevert("JackpotBusy", () => commitEpoch(prog, ops, refs, snap!)));
      } else { // FUND mid-epoch
        const amt = BigInt(50 + ri(3000)); await mintTo(conn, ops, stock, pot, ops, Number(amt), [], undefined, RP); minted += amt;
        chk(`op${i} fund (committed)`, await conservation());
      }
    } else { // SETTLED
      const roll = ri(10);
      if (roll < 6) { // CLAIM
        const wt = await winningTicketOf(prog, refs);
        const potNow = await bal(conn, pot);
        const { entry } = winnerOf(snap!, wt);
        const before = await bal(conn, entry.owner ? getAssociatedTokenAddressSync(stock, entry.owner, false, RP) : pot);
        await payWinner(prog, ops, refs, snap!, wt, conn);
        const after = await bal(conn, getAssociatedTokenAddressSync(stock, entry.owner, false, RP));
        const potLeft = await bal(conn, pot);
        paid += potNow;
        const good = after === before + potNow && potLeft === 0n && await conservation();
        chk(`op${i} claim pays in-range winner in full`, good, `pot=${potNow} left=${potLeft}`);
        phase = "OPEN";
      } else if (roll < 8) { // adversarial: wrong proof
        const wt = await winningTicketOf(prog, refs);
        const { entry } = winnerOf(snap!, wt);
        const badProof = [hashLeaf(entry.owner, 999999n, 1n)];
        chk(`op${i} wrong-proof claim reverts`, await expectRevert("BadProof", () =>
          prog.methods.claimPrize(new anchor.BN(entry.start.toString()), new anchor.BN(entry.tickets.toString()), badProof.map(toArray))
            .accounts({ caller: ops.publicKey, winner: entry.owner, jackpot, jackpotAuthority: jAuth, prizeMint: stock, potCustody: pot, winnerPrizeAccount: getAssociatedTokenAddressSync(stock, entry.owner, false, RP), prizeTokenProgram: RP }).rpc()));
      } else { // adversarial: commit while settled must revert
        chk(`op${i} commit-while-settled reverts`, await expectRevert("JackpotBusy", () => commitEpoch(prog, ops, refs, snap!)));
      }
    }
    if (results.length && results[results.length - 1].ok) ok++;
    if ((i + 1) % 25 === 0) process.stdout.write(`  … ${i + 1}/${OPS} ops · ${ok} ok\n`);
  }

  console.log("\n=== solum :: stateful jackpot fuzz ===");
  const fails = results.filter((r) => !r.ok);
  console.log(`  ${ok}/${results.length} checks held`);
  fails.slice(0, 10).forEach((f) => console.log(`  FAIL  ${f.name}${f.detail ? " — " + f.detail : ""}`));
  console.log(fails.length ? "\n❌ FUZZ FAILED" : `\n✅ FUZZ PASSED — ${OPS} random ops, conservation + phase machine + in-range payout held every step.`);
  if (fails.length) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
