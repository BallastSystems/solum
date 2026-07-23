// Adversarial test for the claim + award flow on a local validator.
// registerClaim: records a signature-verified claim; rejects non-winner / forged / stale / epoch-mismatch.
// awardPrize (operator manual send): pays the exact prize only to a claimed winner, exactly once.

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
import { registerClaim, awardPrize, claimMessage, ClaimConfig } from "./claim";
import { WinnerEntry } from "./status";

const RP = TOKEN_2022_PROGRAM_ID, DEC = 6, PRIZE = 1000n;
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ name, ok });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (!ok && detail ? " — " + detail : ""));
};
const sign = (kp: Keypair, msg: string) =>
  bs58.encode(ed25519.sign(new TextEncoder().encode(msg), kp.secretKey.slice(0, 32)));
const nowMsg = (ep: number) => claimMessage(ep, new Date().toISOString());

async function main() {
  const conn = new Connection(process.env.SOLUM_RPC || "http://127.0.0.1:8899", "confirmed");
  const ops = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(ops.publicKey, 5 * LAMPORTS_PER_SOL));
  const stock = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, RP);
  const opsAta = await createAssociatedTokenAccount(conn, ops, stock, ops.publicKey, {}, RP);
  await mintTo(conn, ops, stock, opsAta, ops, 10000, [], undefined, RP);

  const winner = Keypair.generate();
  const W = winner.publicKey.toBase58();
  const winnersFile = path.join(os.tmpdir(), "solum-claim-test-" + process.pid + ".json");
  const write = (over: Partial<WinnerEntry>) => {
    const e: WinnerEntry = {
      epoch: 7, hourLabel: "3 PM", addr: W, solumHeld: 500, totalTickets: 1000, holders: 3,
      stock: "AAPLx", prizeShares: 0.001, prizeBaseUnits: PRIZE.toString(), prizeUsd: 200,
      drawAt: new Date(Date.now() - 3600 * 1000).toISOString(), claimed: false, claimedAt: null,
      awarded: false, awardTx: null, payoutTx: "", ...over,
    };
    fs.writeFileSync(winnersFile, JSON.stringify([e], null, 2));
  };
  const entry = () => JSON.parse(fs.readFileSync(winnersFile, "utf8"))[0] as WinnerEntry;
  const cfg: ClaimConfig = { conn, ops, stockMint: stock, stockProgram: RP, opsStockAccount: opsAta, winnersFile };
  const bal = async () => {
    const ata = await getOrCreateAssociatedTokenAccount(conn, ops, stock, winner.publicKey, false, undefined, undefined, RP);
    return Number((await getAccount(conn, ata.address, undefined, RP)).amount);
  };

  // --- registerClaim (available immediately, required, recorded) ---
  write({});
  let msg = nowMsg(7);
  const c1 = registerClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) });
  check("valid claim is recorded (claimed + claimedAt)", c1.ok && entry().claimed === true && !!entry().claimedAt);

  msg = nowMsg(7);
  const c2 = registerClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) });
  check("re-claim is idempotent (same claimedAt, still unawarded)", c2.ok && (c2 as any).alreadyClaimed === true && entry().awarded === false);

  write({});
  const imposter = Keypair.generate();
  msg = nowMsg(7);
  check("a non-winner wallet cannot claim", !registerClaim(cfg, { epoch: 7, winner: imposter.publicKey.toBase58(), message: msg, signature: sign(imposter, msg) }).ok);
  msg = nowMsg(7);
  check("a forged signature cannot claim", !registerClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(imposter, msg) }).ok);
  msg = claimMessage(7, new Date(Date.now() - 3600 * 1000).toISOString());
  check("a stale/replayed signature cannot claim", !registerClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) }).ok);
  msg = nowMsg(9);
  check("an epoch-mismatched message cannot claim", !registerClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) }).ok);

  // --- awardPrize (operator manual send) ---
  write({}); // unclaimed
  const a0 = await awardPrize(cfg, 7);
  check("award before claim is rejected", !a0.ok);

  msg = nowMsg(7);
  registerClaim(cfg, { epoch: 7, winner: W, message: msg, signature: sign(winner, msg) }); // claim it
  const a1 = await awardPrize(cfg, 7);
  check("award after claim sends the exact prize", a1.ok && !!(a1 as any).awardTx && (await bal()) === Number(PRIZE));
  check("entry marked awarded + awardTx", entry().awarded === true && !!entry().awardTx);

  const a2 = await awardPrize(cfg, 7);
  check("re-award is idempotent, no double-pay", a2.ok && (a2 as any).alreadyAwarded === true && (await bal()) === Number(PRIZE));

  try { fs.unlinkSync(winnersFile); } catch {}
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
