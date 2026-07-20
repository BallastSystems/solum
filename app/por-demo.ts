// Validates the proof-of-reserves read layer against real on-chain state: stand up a vault,
// deposit stock (buybacks), publish prices, then assert computeReserves() derives the exact
// total reserves and per-token floor. This is the number the dashboard shows — proven correct.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createMint, mintTo, createAssociatedTokenAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { computeReserves } from "./reserves";

const COIN = TOKEN_PROGRAM_ID;
const STK = TOKEN_2022_PROGRAM_ID;

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = new anchor.Program(
    JSON.parse(fs.readFileSync(path.resolve("target/idl/ballast.json"), "utf8")) as anchor.Idl, provider);

  // pump-style classic coin, 1000 whole supply; two Token-2022 stocks
  const coin = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, COIN);
  const aapl = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK);
  const tsla = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK);

  const holder = await createAssociatedTokenAccount(conn, payer, coin, payer.publicKey, {}, COIN);
  await mintTo(conn, payer, coin, holder, payer, 1_000_000_000, [], undefined, COIN); // 1000 whole

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), coin.toBuffer(), payer.publicKey.toBuffer()], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), coin.toBuffer(), payer.publicKey.toBuffer()], program.programId);

  await program.methods.initializeVault(100, 500, payer.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, [aapl, tsla])
    .accounts({ admin: payer.publicKey, tokenMint: coin }).rpc();

  // publish prices: AAPL $150, TSLA $30 (expo 0)
  for (const [mint, price] of [[aapl, 150], [tsla, 30]] as [PublicKey, number][]) {
    await program.methods.setPrice(new anchor.BN(price), 0)
      .accounts({ config: configPda, admin: payer.publicKey, stockMint: mint }).rpc();
  }

  // buybacks: deposit 400 AAPL + 100 TSLA into the vault
  for (const [mint, whole] of [[aapl, 400], [tsla, 100]] as [PublicKey, number][]) {
    const src = await createAssociatedTokenAccount(conn, payer, mint, payer.publicKey, {}, STK);
    await mintTo(conn, payer, mint, src, payer, whole * 1_000_000, [], undefined, STK);
    const vault = await createAssociatedTokenAccount(conn, payer, mint, vaultAuth, {}, STK, undefined, true);
    await program.methods.depositStock(new anchor.BN(whole * 1_000_000))
      .accounts({ config: configPda, vaultAuthority: vaultAuth, stockMint: mint, depositor: payer.publicKey, depositorStockAccount: src, stockVault: vault, stockTokenProgram: STK }).rpc();
  }

  const r = await computeReserves(conn, program, coin, payer.publicKey);

  console.log("\n=== Proof of Reserves ===");
  console.log(`coin ${r.tokenMint.slice(0, 8)}…  supply ${r.supplyWhole}`);
  for (const s of r.stocks) {
    console.log(`  ${s.mint.slice(0, 8)}…  ${s.balanceWhole} @ $${s.price}  =  $${s.valueQuote.toLocaleString()}`);
  }
  console.log(`  total reserves  =  $${r.totalValueQuote.toLocaleString()}`);
  console.log(`  floor / token   =  $${r.floorPerTokenQuote}`);

  // expected: 400*150 + 100*30 = 63000 ; floor = 63000/1000 = 63
  const okTotal = r.totalValueQuote === 63000;
  const okFloor = r.floorPerTokenQuote === 63;
  console.log(`\n  ${okTotal ? "PASS" : "FAIL"}  total reserves = $63,000`);
  console.log(`  ${okFloor ? "PASS" : "FAIL"}  floor = $63 / token`);
  process.exit(okTotal && okFloor ? 0 : 1);
}

main().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(1); });
