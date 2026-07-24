// Creator-fee collection → tokenized-stock buy → fund the pot.
//
// $SOLUM launches on pump.fun, which owns the token contract and pays the creator accrued fees.
// Each hour the bot: (1) collects those creator fees (SOL) to the ops wallet, (2) swaps SOL into a
// tokenized stock via Jupiter, (3) transfers the stock into the jackpot pot custody. Steps 1–2 need
// live mainnet/pump.fun/Jupiter, so they're marked; step 3 is a plain SPL transfer.

import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { transferChecked, getMint } from "@solana/spl-token";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";

const JUP = "https://lite-api.jup.ag/swap/v1"; // Jupiter (routability + swap)
const WSOL = "So11111111111111111111111111111111111111112";

/**
 * Collect accrued pump.fun creator fees to `ops` (the $SOLUM coin creator). Returns lamports collected.
 *
 * Uses @pump-fun/pump-sdk: reads the creator vault balance across both fee programs, and if there is
 * anything to collect, builds + sends pump.fun's `collect_coin_creator_fee`, signed by the creator.
 * GUARDED to mainnet only — pump.fun has no devnet, so this is a no-op off mainnet. NEEDS A MAINNET
 * SMOKE TEST before go-live (fee-sharing-migrated coins may require the V2 collect path; see below).
 */
export async function collectCreatorFees(conn: Connection, ops: Keypair): Promise<number> {
  const ep = (conn as any)._rpcEndpoint as string | undefined;
  const isMainnet = !!ep && !/devnet|testnet|localhost|127\.0\.0\.1/.test(ep);
  if (!isMainnet) return 0; // devnet/local: no pump.fun program present — nothing to collect

  const sdk = new OnlinePumpSdk(conn);
  const accrued = await sdk.getCreatorVaultBalanceBothPrograms(ops.publicKey); // BN, lamports
  const lamports = Number(accrued.toString());
  if (lamports <= 0) return 0;

  // Standard coin-creator collection. If the coin migrated to a fee-sharing config, swap this for
  // collectCoinCreatorFeeV2Instructions(coinCreator, quoteMint, quoteTokenProgram, feePayer).
  const ixs = await sdk.collectCoinCreatorFeeInstructions(ops.publicKey, ops.publicKey);
  if (!ixs.length) return 0;
  const tx = new Transaction().add(...ixs);
  const sig = await conn.sendTransaction(tx, [ops], { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return lamports; // swept to the ops (creator) wallet as SOL
}

/**
 * Random buy schedule (pure, testable). Splits the funding window into `count` unpredictable moments
 * so the bot buys tokenized stock "at random" rather than at a front-runnable fixed time. Returns
 * sorted second-offsets from the window start. Deterministic only via the injected `rand` (default
 * Math.random) so it can be unit-tested. See automation/README.md step 2.
 */
export function randomBuyTimes(windowSec: number, count: number, rand: () => number = Math.random): number[] {
  const n = Math.max(1, Math.floor(count));
  const t: number[] = [];
  for (let i = 0; i < n; i++) t.push(Math.floor(rand() * windowSec));
  return t.sort((a, b) => a - b);
}

/** Read an SPL/Token-2022 account's amount in base units; 0 if the account doesn't exist yet. */
async function readTokenAmount(conn: Connection, account: PublicKey): Promise<bigint> {
  try {
    const b = await conn.getTokenAccountBalance(account, "confirmed");
    return BigInt(b.value.amount);
  } catch {
    return 0n; // ATA not created until the first swap lands
  }
}

/** Swap `solLamports` of SOL into `stockMint` via Jupiter and return the stock ACTUALLY received
 * (base units), measured as the balance delta on `opsStockAccount` — NOT the quote's outAmount, which
 * can differ by up to the slippage tolerance. The advertised prize must equal what the winner will get,
 * so we never quote-estimate the shares. */
export async function buyStock(
  conn: Connection,
  ops: Keypair,
  solLamports: number,
  stockMint: string,
  opsStockAccount: PublicKey,
  slippageBps = 100,
): Promise<{ received: bigint; sig: string }> {
  const q = (await fetch(
    `${JUP}/quote?inputMint=${WSOL}&outputMint=${stockMint}&amount=${solLamports}` +
      `&slippageBps=${slippageBps}&swapMode=ExactIn`,
  ).then((r) => r.json())) as { outAmount?: string };
  if (!q || !q.outAmount) throw new Error("no Jupiter route for the stock buy");

  const before = await readTokenAmount(conn, opsStockAccount);
  const { swapTransaction } = (await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: ops.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  }).then((r) => r.json())) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([ops]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");

  const received = (await readTokenAmount(conn, opsStockAccount)) - before;
  if (received <= 0n) throw new Error("stock swap confirmed but balance delta was 0 — refusing to advertise a phantom prize");
  return { received, sig }; // ACTUAL shares received (the exact prize) + the buy tx (proof of purchase)
}

/** Move `amount` (base units) of `stockMint` from the ops stock account into the pot custody. */
export async function fundPot(
  conn: Connection,
  ops: Keypair,
  stockMint: PublicKey,
  opsStockAccount: PublicKey,
  potCustody: PublicKey,
  tokenProgram: PublicKey,
  amount: bigint,
): Promise<void> {
  const decimals = (await getMint(conn, stockMint, undefined, tokenProgram)).decimals;
  await transferChecked(
    conn, ops, opsStockAccount, stockMint, potCustody, ops, amount, decimals, [], undefined, tokenProgram,
  );
}

/** One hourly funding pass: fees → stock, held in the review (ops) wallet. Returns SOL collected and
 * stock bought — the exact prize for this hour's winner, which stays in the ops wallet through the
 * 24h quality-control hold and is sent to the winner on claim (see automation/claim.ts). `_potCustody`
 * is retained for signature compatibility but is unused: the on-chain program is draw-only now, the
 * prize is not moved into a program vault. */
export async function fundHourly(
  conn: Connection,
  ops: Keypair,
  stockMint: PublicKey,
  opsStockAccount: PublicKey,
  _potCustody: PublicKey,
  tokenProgram: PublicKey,
  targetLamports?: number, // how much SOL to actually spend on the stock (the cycle's allotment). Defaults to just-collected.
): Promise<{ solCollected: number; solSpent: number; stockBought: bigint; buyTx: string }> {
  const collected = await collectCreatorFees(conn, ops); // sweep the vault into the wallet (lamports; 0 if none)
  const bal = await conn.getBalance(ops.publicKey);
  const RESERVE = 50_000_000; // keep ~0.05 SOL for tx fees — never drain the wallet
  let spend = Math.round(targetLamports != null ? targetLamports : collected);
  spend = Math.min(spend, Math.max(0, bal - RESERVE)); // cap to available balance
  if (spend <= 0) return { solCollected: collected / LAMPORTS_PER_SOL, solSpent: 0, stockBought: 0n, buyTx: "" };
  const { received, sig } = await buyStock(conn, ops, spend, stockMint.toBase58(), opsStockAccount);
  // stock held in the ops/review wallet (opsStockAccount) — NOT moved to the pot custody.
  return { solCollected: collected / LAMPORTS_PER_SOL, solSpent: spend / LAMPORTS_PER_SOL, stockBought: received, buyTx: sig };
}
