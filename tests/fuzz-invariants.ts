// Property-based, stateful invariant fuzzer for the Solum vault.
//
// Methodology: keep an off-chain REFERENCE MODEL of expected balances/supply. Run a long
// sequence of RANDOM operations (deposit / redeem / transfer) against the real program on a
// validator. After EVERY operation, read the chain and assert it matches the model AND that
// the core invariants hold — in exact BigInt arithmetic. Any divergence stops the run with a
// reproducible seed + operation log.
//
// Invariants (checked after every op, for every stock):
//   I1 Conservation : vaultBal + Σ holderBal == totalDeposited          (nothing created/destroyed)
//   I2 Floor mono   : reserves/supply never decreases (vaultAfter·supplyBefore >= vaultBefore·supplyAfter)
//   I3 Redeem exact : payout == floor(amt · vaultBefore / supplyBefore), burn == amt
//   I4 Supply       : coin supply only decreases, only by redeem burns
//
//   ENV: FUZZ_EPISODES (default 3)  FUZZ_OPS (per episode, default 120)  FUZZ_SEED (default 1)
//   ANCHOR_PROVIDER_URL, ANCHOR_WALLET required.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, mintTo,
  createAssociatedTokenAccount, getAssociatedTokenAddressSync, getAccount, getMint, transfer,
} from "@solana/spl-token";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, AccountMeta } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const COIN = TOKEN_PROGRAM_ID;   // memecoin: classic SPL
const STK = TOKEN_2022_PROGRAM_ID; // tokenized stock: Token-2022

// ---- deterministic PRNG (mulberry32) so any failure replays exactly ----
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EPISODES = parseInt(process.env.FUZZ_EPISODES || "3");
const OPS = parseInt(process.env.FUZZ_OPS || "120");
const BASE_SEED = parseInt(process.env.FUZZ_SEED || "1");

type Op = { kind: string; detail: string };

class Fail extends Error {
  constructor(public seed: number, public opIndex: number, public log: Op[], msg: string) {
    super(`\n  SEED ${seed}  OP #${opIndex}\n  INVARIANT VIOLATION: ${msg}\n  last ops:\n` +
      log.slice(-6).map((o, i) => `    ${log.length - 6 + i}: ${o.kind} ${o.detail}`).join("\n"));
  }
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = new anchor.Program(
    JSON.parse(fs.readFileSync(path.resolve("target/idl/ballast.json"), "utf8")) as anchor.Idl, provider) as Program;

  let totalOps = 0;
  const t0 = Date.now();

  for (let ep = 0; ep < EPISODES; ep++) {
    const seed = BASE_SEED + ep * 7919;
    const rng = mulberry32(seed);
    const ri = (n: number) => Math.floor(rng() * n);
    const log: Op[] = [];

    // ---- episode config: vary stock count & decimals to cover configurations ----
    const nStocks = 1 + ri(3);            // 1..3 stocks
    const nHolders = 2 + ri(3);           // 2..4 holders
    const coinDec = 6;

    const coin = await createMint(conn, payer, payer.publicKey, null, coinDec, undefined, undefined, COIN);
    const funding = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, STK); // not a stock
    const stocks: PublicKey[] = [];
    const stockDec: Record<string, number> = {};
    for (let i = 0; i < nStocks; i++) {
      const d = [0, 6, 9][ri(3)];
      const m = await createMint(conn, payer, payer.publicKey, null, d, undefined, undefined, STK);
      stocks.push(m); stockDec[m.toBase58()] = d;
    }

    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), coin.toBuffer(), payer.publicKey.toBuffer()], program.programId);
    const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), coin.toBuffer(), payer.publicKey.toBuffer()], program.programId);

    await program.methods.initializeVault(0, 300, Keypair.generate().publicKey, Keypair.generate().publicKey, funding, stocks)
      .accounts({ admin: payer.publicKey, tokenMint: coin }).rpc();

    // vault stock ATAs + operator reserve (funds deposits)
    const vaultAta: Record<string, PublicKey> = {};
    const opStock: Record<string, PublicKey> = {};
    for (const s of stocks) {
      vaultAta[s.toBase58()] = await createAssociatedTokenAccount(conn, payer, s, vaultAuth, {}, STK, undefined, true);
      opStock[s.toBase58()] = await createAssociatedTokenAccount(conn, payer, s, payer.publicKey, {}, STK);
      await mintTo(conn, payer, s, opStock[s.toBase58()], payer, BigInt("1000000000000000"), [], undefined, STK);
    }

    // holders: each a keypair with SOL, a coin ATA, and a stock ATA per stock
    const holders: Keypair[] = [];
    const coinAta: Record<string, PublicKey> = {};
    const holderStockAta: Record<string, Record<string, PublicKey>> = {};
    // model state
    const mHolderCoin: Record<string, bigint> = {};
    const mVault: Record<string, bigint> = {};
    const mHolderStock: Record<string, Record<string, bigint>> = {};
    const mDeposited: Record<string, bigint> = {};
    let mSupply = 0n;

    for (const s of stocks) { mVault[s.toBase58()] = 0n; mDeposited[s.toBase58()] = 0n; }

    // initial supply distributed across holders (random splits)
    const totalSupply = BigInt(500_000_000 + ri(1_000_000_000));
    let remaining = totalSupply;
    for (let h = 0; h < nHolders; h++) {
      const kp = Keypair.generate(); holders.push(kp);
      await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL), "confirmed");
      coinAta[kp.publicKey.toBase58()] = await createAssociatedTokenAccount(conn, payer, coin, kp.publicKey, {}, COIN);
      holderStockAta[kp.publicKey.toBase58()] = {};
      mHolderStock[kp.publicKey.toBase58()] = {};
      for (const s of stocks) {
        holderStockAta[kp.publicKey.toBase58()][s.toBase58()] = await createAssociatedTokenAccount(conn, payer, s, kp.publicKey, {}, STK);
        mHolderStock[kp.publicKey.toBase58()][s.toBase58()] = 0n;
      }
      const share = h === nHolders - 1 ? remaining : (remaining * BigInt(20 + ri(50))) / 100n;
      remaining -= share;
      await mintTo(conn, payer, coin, coinAta[kp.publicKey.toBase58()], payer, share, [], undefined, COIN);
      mHolderCoin[kp.publicKey.toBase58()] = share;
      mSupply += share;
    }

    // amount picker: over-sample boundaries (1, full)
    const pickAmt = (cap: bigint): bigint => {
      if (cap <= 0n) return 0n;
      const r = rng();
      if (r < 0.18) return 1n;                       // dust
      if (r < 0.34) return cap;                       // full
      const pct = BigInt(1 + ri(99));
      const v = (cap * pct) / 100n;
      return v < 1n ? 1n : v;
    };

    const m = (pk: PublicKey, w: boolean): AccountMeta => ({ pubkey: pk, isWritable: w, isSigner: false });

    // ---- verification after every op ----
    const verify = async (opIndex: number, before?: { stock: string; vault: bigint; supply: bigint }[]) => {
      // on-chain supply
      const chainSupply = (await getMint(conn, coin, undefined, COIN)).supply;
      if (chainSupply !== mSupply) throw new Fail(seed, opIndex, log, `supply chain ${chainSupply} != model ${mSupply}`);
      for (const s of stocks) {
        const k = s.toBase58();
        const chainVault = (await getAccount(conn, vaultAta[k], undefined, STK)).amount;
        if (chainVault !== mVault[k]) throw new Fail(seed, opIndex, log, `vault[${k.slice(0, 6)}] chain ${chainVault} != model ${mVault[k]}`);
        // I1 conservation
        let held = 0n;
        for (const h of holders) held += mHolderStock[h.publicKey.toBase58()][k];
        if (chainVault + held !== mDeposited[k]) throw new Fail(seed, opIndex, log, `I1 conservation stock ${k.slice(0, 6)}: vault ${chainVault} + held ${held} != deposited ${mDeposited[k]}`);
        // verify each holder's stock balance matches chain
        for (const h of holders) {
          const hk = h.publicKey.toBase58();
          const cb = (await getAccount(conn, holderStockAta[hk][k], undefined, STK)).amount;
          if (cb !== mHolderStock[hk][k]) throw new Fail(seed, opIndex, log, `holderStock[${hk.slice(0, 6)}][${k.slice(0, 6)}] chain ${cb} != model ${mHolderStock[hk][k]}`);
        }
      }
      // I2 floor monotonicity vs snapshot before this op
      if (before) for (const b of before) {
        const vAfter = mVault[b.stock];
        // vAfter * supplyBefore >= vBefore * supplyAfter
        if (vAfter * b.supply < b.vault * mSupply)
          throw new Fail(seed, opIndex, log, `I2 floor dropped stock ${b.stock.slice(0, 6)}: (${vAfter}/${mSupply}) < (${b.vault}/${b.supply})`);
      }
    };

    await verify(-1); // sanity after setup

    for (let i = 0; i < OPS; i++) {
      const snap = stocks.map((s) => ({ stock: s.toBase58(), vault: mVault[s.toBase58()], supply: mSupply }));
      const choice = rng();

      if (choice < 0.45) {
        // ---- deposit_stock (buyback) ----
        const s = stocks[ri(nStocks)]; const k = s.toBase58();
        const amt = pickAmt(BigInt(1 + ri(2_000_000_000)));
        await program.methods.depositStock(new anchor.BN(amt.toString()))
          .accounts({ config: configPda, vaultAuthority: vaultAuth, stockMint: s, depositor: payer.publicKey,
            depositorStockAccount: opStock[k], stockVault: vaultAta[k], stockTokenProgram: STK }).rpc();
        mVault[k] += amt; mDeposited[k] += amt;
        log.push({ kind: "deposit", detail: `${amt} ${k.slice(0, 6)}` });

      } else if (choice < 0.85) {
        // ---- redeem ----
        const h = holders[ri(nHolders)]; const hk = h.publicKey.toBase58();
        const bal = mHolderCoin[hk];
        if (bal <= 0n || mSupply <= 0n) { i--; continue; }
        const amt = pickAmt(bal);
        if (amt > mSupply) { i--; continue; }
        const remaining: AccountMeta[] = [];
        for (const s of stocks) remaining.push(m(s, false), m(vaultAta[s.toBase58()], true), m(holderStockAta[hk][s.toBase58()], true));
        await program.methods.redeem(new anchor.BN(amt.toString()))
          .accounts({ config: configPda, tokenMint: coin, vaultAuthority: vaultAuth, redeemer: h.publicKey,
            redeemerTokenAccount: coinAta[hk], tokenProgram: COIN, stockTokenProgram: STK })
          .remainingAccounts(remaining).signers([h]).rpc();
        // model: payouts use supply BEFORE burn
        const supplyBefore = mSupply;
        for (const s of stocks) {
          const k = s.toBase58();
          const payout = (amt * mVault[k]) / supplyBefore; // floor
          mVault[k] -= payout; mHolderStock[hk][k] += payout;
        }
        mHolderCoin[hk] -= amt; mSupply -= amt;
        log.push({ kind: "redeem", detail: `${amt} by ${hk.slice(0, 6)} (supplyBefore ${supplyBefore})` });

      } else {
        // ---- transfer coin between holders (changes distribution) ----
        if (nHolders < 2) { i--; continue; }
        let a = ri(nHolders), b = ri(nHolders); if (a === b) b = (b + 1) % nHolders;
        const from = holders[a], to = holders[b]; const fk = from.publicKey.toBase58(), tk = to.publicKey.toBase58();
        if (mHolderCoin[fk] <= 0n) { i--; continue; }
        const amt = pickAmt(mHolderCoin[fk]);
        await transfer(conn, payer, coinAta[fk], coinAta[tk], from, amt, [], undefined, COIN);
        mHolderCoin[fk] -= amt; mHolderCoin[tk] += amt;
        log.push({ kind: "transfer", detail: `${amt} ${fk.slice(0, 6)}->${tk.slice(0, 6)}` });
      }

      await verify(i, snap);
      totalOps++;
      if (totalOps % 25 === 0) process.stdout.write(`  … ${totalOps} ops verified (episode ${ep + 1}/${EPISODES}, seed ${seed})\n`);
    }
    console.log(`  ✓ episode ${ep + 1}/${EPISODES} — ${OPS} ops, ${nStocks} stocks, ${nHolders} holders, seed ${seed}`);
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n✅ FUZZ PASSED — ${totalOps} random operations, every invariant held (I1 conservation, I2 floor-monotonic, I3 redeem-exact, I4 supply). ${secs}s`);
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof Fail) { console.error(`\n❌ ${e.message}`); process.exit(1); }
  console.error("RUNNER ERROR:", e); process.exit(1);
});
