// Adversarial test for claim fulfillment on a local validator. Proves: a valid claim pays the winner
// the exact prize; and every attack is rejected — non-winner, forged signature, before the 24h hold,
// stale/replayed signature, epoch mismatch, and double-claim (no second payment).
//
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 (validator running) then compile + node this file.

import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, createMint, createAssociatedTokenAccount, mintTo,
  getOrCreateAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fulfillClaim, claimMessage, ClaimConfig } from "./claim";
import { WinnerEntry } from "./status";

const RP = TOKEN_2022_PROGRAM_ID, DEC = 6, PRIZE = 1000n;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (!ok && detail ? " — " + detail : ""));
};
const sign = (kp: Keypair, msg: string) =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(msg), kp.secretKey.slice(0, 32)));

async function main() {
  const conn = new Connection(process.env.SOLUM_RPC || "http://127.0.0.1:8899", "confirmed");
  const ops = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(ops.publicKey, 5 * LAMPORTS_PER_SOL));
  const stock = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, RP);
  const opsAta = await createAssociatedTokenAccount(conn, ops, stock, ops.publicKey, {}, RP);
  await mintTo(conn, ops, stock, opsAta, ops, 10000, [], undefined, RP);

  const winner = Keypair.generate();
  const winnersFile = path.join(os.tmpdir(), "solum-claim-test-" + process.pid + ".json");
  const writeEntry = (over: Partial<WinnerEntry>) => {
    const e: WinnerEntry = {
      epoch: 7, hourLabel: "3 PM", addr: winner.publicKey.toBase58(), solumHeld: 500,
      totalTickets: 1000, holders: 3, stock: "AAPLx", prizeShares: 0.001, prizeBaseUnits: PRIZE.toString(),
      prizeUsd: 200, drawAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(),
      claimableAt: new Date(Date.now() - 3600 * 1000).toISOString(), claimed: false, claimTx: null, payoutTx: "",
      ...over,
    };
    fs.writeFileSync(winnersFile, JSON.stringify([e], null, 2));
  };
  const cfg: ClaimConfig = { conn, ops, stockMint: stock, stockProgram: RP, opsStockAccount: opsAta, winnersFile };
  const bal = async () => {
    const ata = await getOrCreateAssociatedTokenAccount(conn, ops, stock, winner.publicKey, false, undefined, undefined, RP);
    return Number((await getAccount(conn, ata.address, undefined, RP)).amount);
  };
  const W = winner.publicKey.toBase58();

  // 1) happy path
  writeEntry({});
  let msg = claimMessage(7, new Date().toISOString());
  const r1 = await fulfillClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) });
  check("valid claim pays the winner", r1.ok && !!(r1 as any).claimTx, JSON.stringify(r1));
  check("winner received EXACTLY the prize", (await bal()) === Number(PRIZE));
  check("entry stamped claimed + claimTx", JSON.parse(fs.readFileSync(winnersFile, "utf8"))[0].claimed === true);

  // 2) double-claim is idempotent — no second payment
  msg = claimMessage(7, new Date().toISOString());
  const r2 = await fulfillClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) });
  check("re-claim = alreadyClaimed, no double-pay", r2.ok && (r2 as any).alreadyClaimed === true && (await bal()) === Number(PRIZE));

  // 3) before the 24h hold → rejected
  writeEntry({ claimableAt: new Date(Date.now() + 3600 * 1000).toISOString() });
  msg = claimMessage(7, new Date().toISOString());
  const r3 = await fulfillClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) });
  check("claim before the 24h hold is rejected", !r3.ok && /hold has not ended/.test((r3 as any).reason));

  // 4) a non-winner wallet is rejected
  writeEntry({});
  const imposter = Keypair.generate();
  msg = claimMessage(7, new Date().toISOString());
  const r4 = await fulfillClaim(cfg, { epoch: 7, winner: imposter.publicKey.toBase58(), message: msg, signature: sign(imposter, msg) });
  check("a non-winner wallet is rejected", !r4.ok && /did not win/.test((r4 as any).reason));

  // 5) a forged signature (right winner, wrong signer) is rejected
  writeEntry({});
  msg = claimMessage(7, new Date().toISOString());
  const r5 = await fulfillClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(imposter, msg) });
  check("a forged signature is rejected", !r5.ok && /signature does not verify/.test((r5 as any).reason));

  // 6) a stale / replayed signature is rejected
  writeEntry({});
  msg = claimMessage(7, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  const r6 = await fulfillClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) });
  check("a stale (replayed) signature is rejected", !r6.ok && /expired/.test((r6 as any).reason));

  // 7) epoch-mismatched message is rejected
  writeEntry({});
  msg = claimMessage(9, new Date().toISOString());
  const r7 = await fulfillClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) });
  check("epoch-mismatched message is rejected", !r7.ok && /does not match/.test((r7 as any).reason));

  try { fs.unlinkSync(winnersFile); } catch {}
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
