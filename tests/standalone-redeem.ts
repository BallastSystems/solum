// Standalone adversarial runner for the redeem floor (no mocha — Node 26 breaks mocha's
// yargs dependency). Same attacks as tests/redeem.ts, run against an already-deployed
// program on the validator at ANCHOR_PROVIDER_URL. Exit 1 if any case fails.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  mintTo,
  createAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, AccountMeta } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const TP = TOKEN_2022_PROGRAM_ID;
const SUPPLY = 1_000_000;
const VAULT_A = 400_000;
const VAULT_B = 100_000;
const REDEEM = 250_000;

type Case = { name: string; ok: boolean; detail?: string };
const results: Case[] = [];

async function expectRevert(name: string, sub: string, fn: () => Promise<any>) {
  try {
    await fn();
    results.push({ name, ok: false, detail: `expected revert "${sub}", but it succeeded` });
  } catch (e: any) {
    const s = e.toString() + (e.logs ? "\n" + e.logs.join("\n") : "");
    results.push({ name, ok: s.includes(sub), detail: s.includes(sub) ? undefined : `expected "${sub}" in: ${s.slice(0, 260)}` });
  }
}
function check(name: string, cond: boolean, detail?: string) {
  results.push({ name, ok: cond, detail: cond ? undefined : detail });
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/ballast.json"), "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const user = Keypair.generate();
  const engine = Keypair.generate().publicKey;
  const swapVenue = Keypair.generate().publicKey;

  await conn.confirmTransaction(await conn.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");

  const ballastMint = await createMint(conn, payer, payer.publicKey, null, 9, undefined, undefined, TP);
  const stockA = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TP);
  const stockB = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TP);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), ballastMint.toBuffer()], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), ballastMint.toBuffer()], program.programId);

  const vaultAtaA = await createAssociatedTokenAccount(conn, payer, stockA, vaultAuth, {}, TP, undefined, true);
  const vaultAtaB = await createAssociatedTokenAccount(conn, payer, stockB, vaultAuth, {}, TP, undefined, true);
  await mintTo(conn, payer, stockA, vaultAtaA, payer, VAULT_A, [], undefined, TP);
  await mintTo(conn, payer, stockB, vaultAtaB, payer, VAULT_B, [], undefined, TP);

  const userBallastAta = await createAssociatedTokenAccount(conn, payer, ballastMint, user.publicKey, {}, TP);
  await mintTo(conn, payer, ballastMint, userBallastAta, payer, SUPPLY, [], undefined, TP);
  const userStockAtaA = await createAssociatedTokenAccount(conn, payer, stockA, user.publicKey, {}, TP);
  const userStockAtaB = await createAssociatedTokenAccount(conn, payer, stockB, user.publicKey, {}, TP);

  await program.methods
    .initializeVault(100, engine, swapVenue, [stockA, stockB])
    .accounts({ admin: payer.publicKey, tokenMint: ballastMint })
    .rpc();

  const m = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({ pubkey, isWritable, isSigner: false });
  const honest = (): AccountMeta[] => [
    m(stockA, false), m(vaultAtaA, true), m(userStockAtaA, true),
    m(stockB, false), m(vaultAtaB, true), m(userStockAtaB, true),
  ];
  const redeem = (amount: number, remaining: AccountMeta[]) =>
    program.methods
      .redeem(new anchor.BN(amount))
      .accounts({
        config: configPda, tokenMint: ballastMint, vaultAuthority: vaultAuth,
        redeemer: user.publicKey, redeemerTokenAccount: userBallastAta, tokenProgram: TP,
      })
      .remainingAccounts(remaining)
      .signers([user])
      .rpc();

  // ---- attacks (must all revert) ----
  const attackerAtaA = await createAssociatedTokenAccount(conn, payer, stockA, engine, {}, TP);
  const hostile = honest(); hostile[1] = m(attackerAtaA, true);
  await expectRevert("hostile vault source rejected", "BadVaultOwner", () => redeem(REDEEM, hostile));

  await expectRevert("over-redeem past supply rejected", "AmountExceedsSupply", () => redeem(SUPPLY + 1, honest()));

  const swapped = honest(); swapped[0] = m(stockB, false);
  await expectRevert("mismatched stock order rejected", "StockMismatch", () => redeem(REDEEM, swapped));

  await expectRevert("zero amount rejected", "ZeroAmount", () => redeem(0, honest()));

  await program.methods.setPause(true).accounts({ config: configPda, admin: payer.publicKey }).rpc();
  await expectRevert("paused redeem rejected", "Paused", () => redeem(REDEEM, honest()));
  await program.methods.setPause(false).accounts({ config: configPda, admin: payer.publicKey }).rpc();

  // ---- honest redeem (must pay exactly, preserve floor) ----
  await redeem(REDEEM, honest());
  const gotA = Number((await getAccount(conn, userStockAtaA, undefined, TP)).amount);
  const gotB = Number((await getAccount(conn, userStockAtaB, undefined, TP)).amount);
  const leftBallast = Number((await getAccount(conn, userBallastAta, undefined, TP)).amount);
  const vaultLeftA = Number((await getAccount(conn, vaultAtaA, undefined, TP)).amount);

  check("stockA payout exact", gotA === (REDEEM * VAULT_A) / SUPPLY, `got ${gotA}, want ${(REDEEM * VAULT_A) / SUPPLY}`);
  check("stockB payout exact", gotB === (REDEEM * VAULT_B) / SUPPLY, `got ${gotB}, want ${(REDEEM * VAULT_B) / SUPPLY}`);
  check("burned exactly redeemed amount", leftBallast === SUPPLY - REDEEM, `left ${leftBallast}`);
  check("per-token floor did not drop", vaultLeftA / (SUPPLY - REDEEM) >= VAULT_A / SUPPLY, `floor ${vaultLeftA / (SUPPLY - REDEEM)} < ${VAULT_A / SUPPLY}`);

  // ---- report ----
  let failed = 0;
  console.log("\n=== ballast :: redeem floor ===");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(1); });
