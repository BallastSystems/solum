// Creator-fee collection → tokenized-stock buy → fund the pot.
//
// $SOLUM launches on pump.fun, which owns the token contract and pays the creator accrued fees.
// Each hour the bot: (1) collects those creator fees (SOL) to the ops wallet, (2) swaps SOL into a
// tokenized stock via Jupiter, (3) transfers the stock into the jackpot pot custody. Steps 1–2 need
// live mainnet/pump.fun/Jupiter, so they're marked; step 3 is a plain SPL transfer.

import {
  Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { transferChecked, getMint } from "@solana/spl-token";

const JUP = "https://lite-api.jup.ag/swap/v1"; // Jupiter (routability + swap)
const WSOL = "So11111111111111111111111111111111111111112";

/**
 * Collect accrued pump.fun creator fees to `ops`. pump.fun exposes a creator-fee collection
 * instruction on its program; wire its SDK/IX here on mainnet. Returns lamports collected.
 *
 * INTEGRATION POINT (mainnet): build + send pump.fun's `collectCoinCreatorFee` for the $SOLUM
 * coin-creator vault, signed by the creator (ops) wallet. On devnet this is a no-op returning 0.
 */
export async function collectCreatorFees(_conn: Connection, _ops: Keypair): Promise<number> {
  // return (await pumpSdk.collectCoinCreatorFee({ creator: ops.publicKey })).lamports;
  return 0; // devnet: no pump.fun program present
}

/** Swap `solLamports` of SOL into `stockMint` via Jupiter and return the stock received (base units). */
export async function buyStock(
  conn: Connection,
  ops: Keypair,
  solLamports: number,
  stockMint: string,
  slippageBps = 100,
): Promise<bigint> {
  const q = (await fetch(
    `${JUP}/quote?inputMint=${WSOL}&outputMint=${stockMint}&amount=${solLamports}` +
      `&slippageBps=${slippageBps}&swapMode=ExactIn`,
  ).then((r) => r.json())) as { outAmount?: string };
  if (!q || !q.outAmount) throw new Error("no Jupiter route for the stock buy");

  const { swapTransaction } = (await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: ops.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  }).then((r) => r.json())) as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  tx.sign([ops]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  return BigInt(q.outAmount);
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
): Promise<{ solCollected: number; stockBought: bigint }> {
  const lamports = await collectCreatorFees(conn, ops);
  if (lamports <= 0) return { solCollected: 0, stockBought: 0n };
  const stock = await buyStock(conn, ops, lamports, stockMint.toBase58());
  // held in the ops/review wallet (opsStockAccount) — NOT moved to the pot custody.
  return { solCollected: lamports / LAMPORTS_PER_SOL, stockBought: stock };
}
