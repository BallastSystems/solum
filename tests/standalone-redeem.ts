// Standalone runner for the pump.fun model: a classic-SPL coin (like a pump.fun launch)
// backed by Token-2022 tokenized stock deposited via manual buybacks.
//
// Proves: deposit_stock adds backing (buyback provenance); redeem burns the classic-SPL coin
// AND pays out Token-2022 stock in one instruction (dual token programs); and every attack on
// both paths reverts. The only way value leaves the vault is a holder redeeming their own share.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createMint, mintTo, createAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, AccountMeta } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const COIN = TOKEN_PROGRAM_ID;     // pump.fun coin = classic SPL
const STK = TOKEN_2022_PROGRAM_ID; // xStocks = Token-2022

const SUPPLY = 1_000_000;
const VAULT_A = 400_000;
const VAULT_B = 100_000;
const REDEEM = 250_000;

type Case = { name: string; ok: boolean; detail?: string };
const results: Case[] = [];
async function expectRevert(name: string, sub: string, fn: () => Promise<any>) {
  try { await fn(); results.push({ name, ok: false, detail: `expected "${sub}", succeeded` }); }
  catch (e: any) {
    const s = e.toString() + (e.logs ? "\n" + e.logs.join("\n") : "");
    results.push({ name, ok: s.includes(sub), detail: s.includes(sub) ? undefined : s.slice(0, 240) });
  }
}
function check(name: string, cond: boolean, detail?: string) { results.push({ name, ok: cond, detail: cond ? undefined : detail }); }

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = new anchor.Program(
    JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8")) as anchor.Idl, provider) as Program;

  const user = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL), "confirmed");

  // classic-SPL coin (pump.fun-style) + two Token-2022 stocks
  const coin = await createMint(conn, payer, payer.publicKey, null, 9, undefined, undefined, COIN);
  const stockA = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK);
  const stockB = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), coin.toBuffer(), payer.publicKey.toBuffer()], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), coin.toBuffer(), payer.publicKey.toBuffer()], program.programId);

  await program.methods
    .initializeVault(100, 500, user.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, [stockA, stockB])
    .accounts({ admin: payer.publicKey, tokenMint: coin })
    .rpc();

  const vaultAtaA = await createAssociatedTokenAccount(conn, payer, stockA, vaultAuth, {}, STK, undefined, true);
  const vaultAtaB = await createAssociatedTokenAccount(conn, payer, stockB, vaultAuth, {}, STK, undefined, true);

  const userCoin = await createAssociatedTokenAccount(conn, payer, coin, user.publicKey, {}, COIN);
  await mintTo(conn, payer, coin, userCoin, payer, SUPPLY, [], undefined, COIN);
  const userStockA = await createAssociatedTokenAccount(conn, payer, stockA, user.publicKey, {}, STK);
  const userStockB = await createAssociatedTokenAccount(conn, payer, stockB, user.publicKey, {}, STK);

  // depositor (operator buyback) stock accounts, funded
  const opStockA = await createAssociatedTokenAccount(conn, payer, stockA, payer.publicKey, {}, STK);
  const opStockB = await createAssociatedTokenAccount(conn, payer, stockB, payer.publicKey, {}, STK);
  await mintTo(conn, payer, stockA, opStockA, payer, VAULT_A * 2, [], undefined, STK);
  await mintTo(conn, payer, stockB, opStockB, payer, VAULT_B * 2, [], undefined, STK);

  const deposit = (stockMint: PublicKey, src: PublicKey, vault: PublicKey, amount: number) =>
    program.methods.depositStock(new anchor.BN(amount))
      .accounts({ config: configPda, vaultAuthority: vaultAuth, stockMint, depositor: payer.publicKey, depositorStockAccount: src, stockVault: vault, stockTokenProgram: STK })
      .rpc();

  // ---- deposit_stock: fund the vault (buybacks) ----
  await deposit(stockA, opStockA, vaultAtaA, VAULT_A);
  await deposit(stockB, opStockB, vaultAtaB, VAULT_B);
  check("deposit_stock funded vault A", Number((await getAccount(conn, vaultAtaA, undefined, STK)).amount) === VAULT_A);
  check("deposit_stock funded vault B", Number((await getAccount(conn, vaultAtaB, undefined, STK)).amount) === VAULT_B);

  // ATTACK: deposit into a non-vault account is rejected
  const attackerStock = await createAssociatedTokenAccount(conn, payer, stockA, Keypair.generate().publicKey, {}, STK);
  await expectRevert("deposit to non-vault account rejected", "BadVaultOwner", () => deposit(stockA, opStockA, attackerStock, 1));

  // ---- redeem: dual-program (burn classic coin, pay Token-2022 stock) ----
  const m = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({ pubkey, isWritable, isSigner: false });
  const honest = (): AccountMeta[] => [
    m(stockA, false), m(vaultAtaA, true), m(userStockA, true),
    m(stockB, false), m(vaultAtaB, true), m(userStockB, true),
  ];
  const redeem = (amount: number, remaining: AccountMeta[]) =>
    program.methods.redeem(new anchor.BN(amount))
      .accounts({ config: configPda, tokenMint: coin, vaultAuthority: vaultAuth, redeemer: user.publicKey, redeemerTokenAccount: userCoin, tokenProgram: COIN, stockTokenProgram: STK })
      .remainingAccounts(remaining).signers([user]).rpc();

  const hostile = honest(); hostile[1] = m(attackerStock, true);
  await expectRevert("hostile vault source rejected", "BadVaultOwner", () => redeem(REDEEM, hostile));
  await expectRevert("over-redeem rejected", "AmountExceedsSupply", () => redeem(SUPPLY + 1, honest()));
  const swapped = honest(); swapped[0] = m(stockB, false);
  await expectRevert("stock mismatch rejected", "StockMismatch", () => redeem(REDEEM, swapped));
  await expectRevert("zero amount rejected", "ZeroAmount", () => redeem(0, honest()));
  // The floor must always be redeemable — a compromised admin must NOT be able to freeze it.
  // Pause the vault, then redeem anyway: it must succeed.
  await program.methods.setPause(true).accounts({ config: configPda, admin: payer.publicKey }).rpc();
  await redeem(REDEEM, honest());
  check("redeem works even while the vault is paused", Number((await getAccount(conn, userCoin, undefined, COIN)).amount) === SUPPLY - REDEEM);
  const gotA = Number((await getAccount(conn, userStockA, undefined, STK)).amount);
  const gotB = Number((await getAccount(conn, userStockB, undefined, STK)).amount);
  const leftCoin = Number((await getAccount(conn, userCoin, undefined, COIN)).amount);
  const vaultLeftA = Number((await getAccount(conn, vaultAtaA, undefined, STK)).amount);
  check("stockA payout exact", gotA === (REDEEM * VAULT_A) / SUPPLY, `got ${gotA}`);
  check("stockB payout exact", gotB === (REDEEM * VAULT_B) / SUPPLY, `got ${gotB}`);
  check("burned exactly redeemed amount", leftCoin === SUPPLY - REDEEM, `left ${leftCoin}`);
  check("floor preserved", vaultLeftA / (SUPPLY - REDEEM) >= VAULT_A / SUPPLY);

  let failed = 0;
  console.log("\n=== ballast :: pump.fun model (deposit + dual-program redeem) ===");
  for (const r of results) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`); if (!r.ok) failed++; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(1); });
