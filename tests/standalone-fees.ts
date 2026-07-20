// Standalone runner for the Token-2022 transfer-fee harvest path.
//
// Creates a real transfer-fee mint whose fee-config AND withdraw-withheld authorities are the
// Ballast `fee_authority` PDA, accrues fees via a taxed transfer, and proves:
//   * harvest_fees pulls the withheld fees into the vault-owned fee account, and
//   * an attacker cannot redirect withheld fees to an account they own (BadVaultOwner).
// The tax rate is frozen (no instruction changes it) and no human key can move withheld fees.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeTransferFeeConfigInstruction, createInitializeMintInstruction,
  createAssociatedTokenAccount, mintTo, transferCheckedWithFee, harvestWithheldTokensToMint,
  getAccount,
} from "@solana/spl-token";
import {
  PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const TP = TOKEN_2022_PROGRAM_ID;
const DECIMALS = 6;
const FEE_BPS = 100;         // 1%
const XFER = 100_000;
const EXPECTED_FEE = 1000;   // 100_000 * 1%

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function expectRevert(name: string, sub: string, fn: () => Promise<any>) {
  try { await fn(); results.push({ name, ok: false, detail: `expected "${sub}", succeeded` }); }
  catch (e: any) {
    const s = e.toString() + (e.logs ? "\n" + e.logs.join("\n") : "");
    results.push({ name, ok: s.includes(sub), detail: s.includes(sub) ? undefined : s.slice(0, 260) });
  }
}
function check(name: string, cond: boolean, detail?: string) { results.push({ name, ok: cond, detail: cond ? undefined : detail }); }

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const ballast = new anchor.Program(
    JSON.parse(fs.readFileSync(path.resolve("target/idl/ballast.json"), "utf8")) as anchor.Idl, provider);

  // --- create a transfer-fee mint whose authorities are the fee_authority PDA ---
  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;
  const [feeAuth] = PublicKey.findProgramAddressSync([Buffer.from("fee"), mint.toBuffer()], ballast.programId);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer(), payer.publicKey.toBuffer()], ballast.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer(), payer.publicKey.toBuffer()], ballast.programId);

  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint, space: mintLen, lamports, programId: TP }),
    createInitializeTransferFeeConfigInstruction(mint, feeAuth, feeAuth, FEE_BPS, BigInt(1_000_000_000), TP),
    createInitializeMintInstruction(mint, DECIMALS, payer.publicKey, null, TP),
  ), [payer, mintKp]);

  // vault for this mint (stocks/venue irrelevant to harvest — dummy values)
  await ballast.methods
    .initializeVault(FEE_BPS, 500, Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, [Keypair.generate().publicKey])
    .accounts({ admin: payer.publicKey, tokenMint: mint })
    .rpc();

  const feeVault = await createAssociatedTokenAccount(conn, payer, mint, vaultAuth, {}, TP, undefined, true);

  // --- accrue a fee: a taxed transfer withholds into the destination account ---
  const srcAta = await createAssociatedTokenAccount(conn, payer, mint, payer.publicKey, {}, TP);
  await mintTo(conn, payer, mint, srcAta, payer, 1_000_000, [], undefined, TP);
  const dest = Keypair.generate();
  const destAta = await createAssociatedTokenAccount(conn, payer, mint, dest.publicKey, {}, TP);
  await transferCheckedWithFee(conn, payer, srcAta, mint, destAta, payer, BigInt(XFER), DECIMALS, BigInt(EXPECTED_FEE), [], undefined, TP);

  // sweep withheld from the holder account to the mint (permissionless Token-2022 step)
  await harvestWithheldTokensToMint(conn, payer, mint, [destAta], undefined, TP);

  // --- ATTACK: try to harvest into an attacker-owned account ---
  const attacker = Keypair.generate();
  const attackerAta = await createAssociatedTokenAccount(conn, payer, mint, attacker.publicKey, {}, TP);
  await expectRevert("harvest to attacker account rejected", "BadVaultOwner", () =>
    ballast.methods.harvestFees()
      .accounts({ config: configPda, tokenMint: mint, feeAuthority: feeAuth, vaultAuthority: vaultAuth, feeVault: attackerAta, tokenProgram: TP })
      .rpc());

  // --- HONEST: harvest into the vault fee account ---
  await ballast.methods.harvestFees()
    .accounts({ config: configPda, tokenMint: mint, feeAuthority: feeAuth, vaultAuthority: vaultAuth, feeVault, tokenProgram: TP })
    .rpc();
  const got = Number((await getAccount(conn, feeVault, undefined, TP)).amount);
  check("withheld fees land in the vault fee account", got === EXPECTED_FEE, `got ${got}, want ${EXPECTED_FEE}`);

  let failed = 0;
  console.log("\n=== ballast :: transfer-fee harvest ===");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(1); });
