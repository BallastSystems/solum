// Adversarial + correctness tests for the redeem floor.
//
// The whole protocol rests on one claim: nobody can pull a vault asset except a holder
// redeeming their OWN burn-backed pro-rata share. These tests try to break that claim —
// a hostile remaining-accounts set, an over-redeem, a paused vault, a mismatched stock —
// and assert each attack fails, then assert the honest path pays out exactly.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Solum } from "../target/types/solum";
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  mintTo,
  createAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  AccountMeta,
} from "@solana/web3.js";
import { assert } from "chai";

const TP = TOKEN_2022_PROGRAM_ID;

// Base-unit test economics (clean divisions):
//   supply = 1_000_000 ; vaultA = 400_000 ; vaultB = 100_000
//   redeem 250_000 (25%) -> payoutA = 100_000, payoutB = 25_000
const SUPPLY = 1_000_000;
const VAULT_A = 400_000;
const VAULT_B = 100_000;
const REDEEM = 250_000;

describe("ballast :: redeem floor", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Solum as Program<Solum>;
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const user = Keypair.generate();
  const engine = Keypair.generate().publicKey;
  const swapVenue = Keypair.generate().publicKey;

  let ballastMint: PublicKey;
  let stockA: PublicKey;
  let stockB: PublicKey;
  let configPda: PublicKey;
  let vaultAuth: PublicKey;
  let vaultAtaA: PublicKey;
  let vaultAtaB: PublicKey;
  let userBallastAta: PublicKey;
  let userStockAtaA: PublicKey;
  let userStockAtaB: PublicKey;

  const meta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
    pubkey,
    isWritable,
    isSigner: false,
  });

  before(async () => {
    await conn.confirmTransaction(
      await conn.requestAirdrop(user.publicKey, 5 * LAMPORTS_PER_SOL),
      "confirmed"
    );

    // Ballast token (Token-2022) and two "stock" mints, all with payer as mint authority.
    ballastMint = await createMint(conn, payer, payer.publicKey, null, 9, undefined, undefined, TP);
    stockA = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TP);
    stockB = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TP);

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), ballastMint.toBuffer()],
      program.programId
    );
    [vaultAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), ballastMint.toBuffer()],
      program.programId
    );

    // Vault stock accounts owned by the vault PDA (off-curve), funded.
    vaultAtaA = await createAssociatedTokenAccount(conn, payer, stockA, vaultAuth, {}, TP, undefined, true);
    vaultAtaB = await createAssociatedTokenAccount(conn, payer, stockB, vaultAuth, {}, TP, undefined, true);
    await mintTo(conn, payer, stockA, vaultAtaA, payer, VAULT_A, [], undefined, TP);
    await mintTo(conn, payer, stockB, vaultAtaB, payer, VAULT_B, [], undefined, TP);

    // User holds the full Ballast supply and has receiving accounts for each stock.
    userBallastAta = await createAssociatedTokenAccount(conn, payer, ballastMint, user.publicKey, {}, TP);
    await mintTo(conn, payer, ballastMint, userBallastAta, payer, SUPPLY, [], undefined, TP);
    userStockAtaA = await createAssociatedTokenAccount(conn, payer, stockA, user.publicKey, {}, TP);
    userStockAtaB = await createAssociatedTokenAccount(conn, payer, stockB, user.publicKey, {}, TP);

    await program.methods
      .initializeVault(100, engine, swapVenue, [stockA, stockB])
      .accounts({
        admin: payer.publicKey,
        tokenMint: ballastMint,
      })
      .rpc();
  });

  // Ordered stock triples the redeem handler expects: [mint, vaultAta, userAta] per stock.
  const honestRemaining = (): AccountMeta[] => [
    meta(stockA, false), meta(vaultAtaA, true), meta(userStockAtaA, true),
    meta(stockB, false), meta(vaultAtaB, true), meta(userStockAtaB, true),
  ];

  const doRedeem = (amount: number, remaining: AccountMeta[]) =>
    program.methods
      .redeem(new anchor.BN(amount))
      .accounts({
        config: configPda,
        tokenMint: ballastMint,
        vaultAuthority: vaultAuth,
        redeemer: user.publicKey,
        redeemerTokenAccount: userBallastAta,
        tokenProgram: TP,
      })
      .remainingAccounts(remaining)
      .signers([user])
      .rpc();

  it("ATTACK: hostile vault source (attacker's own account) is rejected", async () => {
    // Attacker swaps in a token account they control as the "vault" source of stockA.
    const attackerAtaA = await createAssociatedTokenAccount(conn, payer, stockA, engine, {}, TP);
    const hostile = honestRemaining();
    hostile[1] = meta(attackerAtaA, true); // replace vaultAtaA
    try {
      await doRedeem(REDEEM, hostile);
      assert.fail("hostile source should have been rejected");
    } catch (e: any) {
      assert.include(e.toString(), "BadVaultOwner");
    }
  });

  it("ATTACK: over-redeem past total supply is rejected", async () => {
    try {
      await doRedeem(SUPPLY + 1, honestRemaining());
      assert.fail("over-redeem should have been rejected");
    } catch (e: any) {
      assert.include(e.toString(), "AmountExceedsSupply");
    }
  });

  it("ATTACK: mismatched stock mint order is rejected", async () => {
    const swapped = honestRemaining();
    swapped[0] = meta(stockB, false); // claim index 0 is stockB, but allowlist[0] == stockA
    try {
      await doRedeem(REDEEM, swapped);
      assert.fail("stock mismatch should have been rejected");
    } catch (e: any) {
      assert.include(e.toString(), "StockMismatch");
    }
  });

  it("ATTACK: zero amount is rejected", async () => {
    try {
      await doRedeem(0, honestRemaining());
      assert.fail("zero amount should have been rejected");
    } catch (e: any) {
      assert.include(e.toString(), "ZeroAmount");
    }
  });

  it("ATTACK: redeeming a paused vault is rejected", async () => {
    await program.methods.setPause(true).accounts({ config: configPda, admin: payer.publicKey }).rpc();
    try {
      await doRedeem(REDEEM, honestRemaining());
      assert.fail("paused redeem should have been rejected");
    } catch (e: any) {
      assert.include(e.toString(), "Paused");
    } finally {
      await program.methods.setPause(false).accounts({ config: configPda, admin: payer.publicKey }).rpc();
    }
  });

  it("HONEST: redeems exactly the pro-rata share and preserves the floor", async () => {
    const before = await getAccount(conn, userBallastAta, undefined, TP);
    assert.equal(Number(before.amount), SUPPLY);

    await doRedeem(REDEEM, honestRemaining());

    const gotA = Number((await getAccount(conn, userStockAtaA, undefined, TP)).amount);
    const gotB = Number((await getAccount(conn, userStockAtaB, undefined, TP)).amount);
    const leftBallast = Number((await getAccount(conn, userBallastAta, undefined, TP)).amount);
    const vaultLeftA = Number((await getAccount(conn, vaultAtaA, undefined, TP)).amount);
    const vaultLeftB = Number((await getAccount(conn, vaultAtaB, undefined, TP)).amount);

    // payout = amount * vaultBalance / supply, rounded down
    assert.equal(gotA, (REDEEM * VAULT_A) / SUPPLY, "stockA payout");
    assert.equal(gotB, (REDEEM * VAULT_B) / SUPPLY, "stockB payout");
    assert.equal(leftBallast, SUPPLY - REDEEM, "burned exactly the redeemed amount");

    // Floor invariant: vault/supply per token must not fall.
    const floorBeforeA = VAULT_A / SUPPLY;
    const floorAfterA = vaultLeftA / (SUPPLY - REDEEM);
    assert.isAtLeast(floorAfterA, floorBeforeA, "per-token floor of stockA must not drop");
    assert.equal(vaultLeftB, VAULT_B - gotB, "vault stockB decremented by payout only");
  });
});
