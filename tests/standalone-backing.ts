// Standalone adversarial runner for add_backing (the fees -> stock -> vault path).
//
// Proves the net-effect guard against a controllable mock venue: an honest fair fill lands
// stock in the vault; a shortchange fill, a wrong venue, a non-engine caller, and a paused
// vault all revert. The engine can trigger backing but can never make the vault worse off.
//
// Economics: funding + stock both 6 decimals. Oracle: 1 stock = 2 funding (price=2, expo=0).
//   amount_in = 1000 -> oracle fair_out = 500 ; max_slippage 5% -> floor = 475.
//   fair pool rate 1/2 -> out 500 >= 475 (pass) ; shortchange rate 1/3 -> out 333 < 475 (revert).

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID, createMint, mintTo, createAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, AccountMeta } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const TP = TOKEN_2022_PROGRAM_ID;
const FUND = 100_000;
const AMOUNT_IN = 1000;
const FAIR_OUT = 500;

type Case = { name: string; ok: boolean; detail?: string };
const results: Case[] = [];
async function expectRevert(name: string, sub: string, fn: () => Promise<any>) {
  try { await fn(); results.push({ name, ok: false, detail: `expected revert "${sub}", succeeded` }); }
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
  const ballastIdl = JSON.parse(fs.readFileSync(path.resolve("target/idl/ballast.json"), "utf8"));
  const mockIdl = JSON.parse(fs.readFileSync(path.resolve("target/idl/mock_venue.json"), "utf8"));
  const ballast = new anchor.Program(ballastIdl as anchor.Idl, provider);
  const mock = new anchor.Program(mockIdl as anchor.Idl, provider);

  const engine = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(engine.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");

  const ballastMint = await createMint(conn, payer, payer.publicKey, null, 9, undefined, undefined, TP);
  const stock = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TP);
  const funding = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TP);

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), ballastMint.toBuffer()], ballast.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), ballastMint.toBuffer()], ballast.programId);
  const [priceFeed] = PublicKey.findProgramAddressSync([Buffer.from("price"), stock.toBuffer()], ballast.programId);

  await ballast.methods
    .initializeVault(100, 500, engine.publicKey, mock.programId, [stock])
    .accounts({ admin: payer.publicKey, tokenMint: ballastMint })
    .rpc();

  await ballast.methods.setPrice(new anchor.BN(2), 0)
    .accounts({ config: configPda, admin: payer.publicKey, stockMint: stock })
    .rpc();

  // vault funding + stock accounts (vault-owned), funding filled
  const fundingVault = await createAssociatedTokenAccount(conn, payer, funding, vaultAuth, {}, TP, undefined, true);
  const stockVault = await createAssociatedTokenAccount(conn, payer, stock, vaultAuth, {}, TP, undefined, true);
  await mintTo(conn, payer, funding, fundingVault, payer, FUND, [], undefined, TP);

  // mock pool: fair rate 1/2, reserves funded with stock
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), funding.toBuffer(), stock.toBuffer()], mock.programId);
  const [poolAuth] = PublicKey.findProgramAddressSync([Buffer.from("pool-auth"), funding.toBuffer(), stock.toBuffer()], mock.programId);
  await mock.methods.initPool(new anchor.BN(1), new anchor.BN(2))
    .accounts({ payer: payer.publicKey, fundingMint: funding, stockMint: stock })
    .rpc();
  const poolFunding = await createAssociatedTokenAccount(conn, payer, funding, poolAuth, {}, TP, undefined, true);
  const poolStock = await createAssociatedTokenAccount(conn, payer, stock, poolAuth, {}, TP, undefined, true);
  await mintTo(conn, payer, stock, poolStock, payer, 1_000_000, [], undefined, TP);

  const m = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({ pubkey, isWritable, isSigner: false });
  const poolAccounts = (): AccountMeta[] => [
    m(poolPda, false), m(poolFunding, true), m(poolStock, true), m(poolAuth, false),
    m(funding, false), m(stock, false), m(TP, false),
  ];
  const backing = (venue: PublicKey, signer: Keypair, enginePk: PublicKey) =>
    ballast.methods.addBacking(new anchor.BN(AMOUNT_IN))
      .accounts({
        config: configPda, engine: enginePk, vaultAuthority: vaultAuth,
        fundingVault, stockVault, stockMint: stock, fundingMint: funding,
        priceFeed, swapVenue: venue,
      })
      .remainingAccounts(poolAccounts())
      .signers([signer])
      .rpc();

  // ---- HONEST fair fill (commits) ----
  await (async () => {
    try {
      await backing(mock.programId, engine, engine.publicKey);
      const gotStock = Number((await getAccount(conn, stockVault, undefined, TP)).amount);
      const leftFunding = Number((await getAccount(conn, fundingVault, undefined, TP)).amount);
      check("honest fill delivers >= oracle floor", gotStock === FAIR_OUT, `stock ${gotStock}, want ${FAIR_OUT}`);
      check("honest fill spends exactly amount_in", leftFunding === FUND - AMOUNT_IN, `funding ${leftFunding}`);
    } catch (e: any) {
      check("honest fill delivers >= oracle floor", false, e.toString().slice(0, 300));
    }
  })();

  // ---- attacks (must revert) ----
  await expectRevert("wrong venue rejected", "WrongVenue", () => backing(Keypair.generate().publicKey, engine, engine.publicKey));

  const notEngine = Keypair.generate();
  await conn.confirmTransaction(await conn.requestAirdrop(notEngine.publicKey, LAMPORTS_PER_SOL), "confirmed");
  await expectRevert("non-engine caller rejected", "Unauthorized", () => backing(mock.programId, notEngine, notEngine.publicKey));

  await ballast.methods.setPause(true).accounts({ config: configPda, admin: payer.publicKey }).rpc();
  await expectRevert("paused backing rejected", "Paused", () => backing(mock.programId, engine, engine.publicKey));
  await ballast.methods.setPause(false).accounts({ config: configPda, admin: payer.publicKey }).rpc();

  // flip the pool to a shortchange rate 1/3 -> out 333 < floor 475
  await mock.methods.setRate(new anchor.BN(1), new anchor.BN(3)).accounts({ pool: poolPda }).rpc();
  await expectRevert("shortchange fill rejected", "InsufficientBacking", () => backing(mock.programId, engine, engine.publicKey));

  let failed = 0;
  console.log("\n=== ballast :: add_backing ===");
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("RUNNER ERROR:", e); process.exit(1); });
