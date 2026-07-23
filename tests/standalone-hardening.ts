// Adversarial tests for the security-review fixes:
//   1. Front-running: a vault is uniquely (coin, admin); a second party's vault for the same
//      coin is a SEPARATE account they cannot use to touch the operator's, and non-admins
//      cannot control the operator's vault.
//   2. Funding pin: the funding asset may never be a backing stock (init-side guard).
//   3. Oracle scoping: an admin can only price stocks in their own vault's allowlist.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint } from "@solana/spl-token";
import { PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const COIN = TOKEN_PROGRAM_ID, STK = TOKEN_2022_PROGRAM_ID;
const results: { name: string; ok: boolean; detail?: string }[] = [];
async function expectRevert(name: string, sub: string, fn: () => Promise<any>) {
  try { await fn(); results.push({ name, ok: false, detail: `expected "${sub}", succeeded` }); }
  catch (e: any) { const s = e.toString() + (e.logs ? "\n" + e.logs.join("\n") : ""); results.push({ name, ok: s.includes(sub), detail: s.includes(sub) ? undefined : s.slice(0, 220) }); }
}
function check(name: string, cond: boolean, detail?: string) { results.push({ name, ok: cond, detail: cond ? undefined : detail }); }

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = new anchor.Program(
    JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8")) as anchor.Idl, provider) as Program;
  const cfgPda = (coin: PublicKey, admin: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("config"), coin.toBuffer(), admin.toBuffer()], program.programId)[0];

  const coin = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, COIN);
  const stockA = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK);
  const stockX = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK); // NOT allowlisted
  const funding = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK);

  // operator vault
  await program.methods.initializeVault(0, 300, payer.publicKey, Keypair.generate().publicKey, funding, [stockA])
    .accounts({ admin: payer.publicKey, tokenMint: coin }).rpc();
  const opConfig = cfgPda(coin, payer.publicKey);

  // 2. funding may not be a stock
  const coin2 = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, COIN);
  await expectRevert("funding-mint cannot be a stock", "FundingIsStock", () =>
    program.methods.initializeVault(0, 300, payer.publicKey, Keypair.generate().publicKey, stockA, [stockA])
      .accounts({ admin: payer.publicKey, tokenMint: coin2 }).rpc());

  // 3. admin can only price allowlisted stocks
  await expectRevert("set_price rejects non-allowlisted stock", "StockMismatch", () =>
    program.methods.setPrice(new anchor.BN(150), 0)
      .accounts({ config: opConfig, admin: payer.publicKey, stockMint: stockX }).rpc());

  // 1. front-running: an attacker's vault for the same coin is a SEPARATE account...
  const attacker = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(attacker.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
  await program.methods.initializeVault(0, 300, attacker.publicKey, Keypair.generate().publicKey, funding, [stockA])
    .accounts({ admin: attacker.publicKey, tokenMint: coin }).signers([attacker]).rpc();
  check("attacker's vault is a different account", cfgPda(coin, attacker.publicKey).toBase58() !== opConfig.toBase58());

  // ...and the attacker cannot control the operator's vault
  await expectRevert("non-admin cannot pause operator vault", "Unauthorized", () =>
    program.methods.setPause(true).accounts({ config: opConfig, admin: attacker.publicKey }).signers([attacker]).rpc());

  let failed = 0;
  console.log("\n=== solum :: hardening (security-review fixes) ===");
  for (const r of results) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`); if (!r.ok) failed++; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(1); });
