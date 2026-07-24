// Track the pump.fun creator fees earned + claimed by the $SOLUM dev/creator wallet — this feeds the
// site's fee ledger ("creator fees, all-time" and "allotted to the next draw"). READ-ONLY: no keys,
// nothing signed or moved on-chain. pump.fun is mainnet-only, so this reads mainnet.

import { Connection, PublicKey } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import * as fs from "fs";

const LAMPORTS = 1e9;

/** Currently accrued (UNCLAIMED) pump.fun creator fees for `creator`, in lamports. Robust to the
 * creator vault not existing yet (pre-launch / pre-graduation) — returns 0 instead of throwing. */
export async function getAccruedCreatorFees(conn: Connection, creator: PublicKey): Promise<number> {
  const sdk = new OnlinePumpSdk(conn);
  try {
    return Number((await sdk.getCreatorVaultBalanceBothPrograms(creator)).toString());
  } catch {
    try { return Number((await sdk.getCreatorVaultBalance(creator)).toString()); } catch { return 0; }
  }
}

export type CreatorFeeStats = {
  updatedAt: string; // ISO
  accruedSol: number; // unclaimed right now (sitting in the creator vault)
  claimedAllTimeSol: number; // swept out to the wallet since tracking began
  earnedAllTimeSol: number; // claimed + accrued
};

/**
 * Poll the accrued creator fees; when they DROP (a claim swept the vault), add the delta to the
 * all-time claimed total. Persists to `stateFile` so the running total survives restarts, and writes
 * a clean CreatorFeeStats the site/bot can read each tick.
 *
 * Note: this accounts for claims from the moment tracking starts. Fees claimed BEFORE the tracker
 * first ran aren't counted (would need a full history backfill) — start it at/near launch for an
 * accurate all-time figure.
 */
export async function trackCreatorFees(
  conn: Connection, creator: PublicKey, stateFile: string, intervalSec = 60,
): Promise<void> {
  let claimed = 0, lastAccrued = 0;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    claimed = s.claimedLamports || 0; lastAccrued = s.accruedLamports || 0;
  } catch { /* first run */ }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const accrued = await getAccruedCreatorFees(conn, creator);
    if (accrued < lastAccrued) claimed += lastAccrued - accrued; // vault dropped → a collect happened
    lastAccrued = accrued;

    const stats: CreatorFeeStats = {
      updatedAt: new Date().toISOString(),
      accruedSol: accrued / LAMPORTS,
      claimedAllTimeSol: claimed / LAMPORTS,
      earnedAllTimeSol: (claimed + accrued) / LAMPORTS,
    };
    fs.mkdirSync(require("path").dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...stats, claimedLamports: claimed, accruedLamports: accrued }, null, 2));
    console.log(`[creator-fees] earned ${stats.earnedAllTimeSol.toFixed(4)} SOL (accrued ${stats.accruedSol.toFixed(4)} + claimed ${stats.claimedAllTimeSol.toFixed(4)})`);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

// CLI. One-shot read:            node creator-fees.js <creator-wallet>
//     Continuous tracker:        SOLUM_FEE_STATE=fees.json node creator-fees.js <creator-wallet> --track
if (require.main === module) {
  (async () => {
    const wallet = process.argv[2] || process.env.SOLUM_CREATOR_WALLET;
    if (!wallet) { console.error("usage: node creator-fees.js <creator-wallet> [--track]"); process.exit(1); }
    const conn = new Connection(process.env.SOLUM_RPC || "https://api.mainnet-beta.solana.com", "confirmed");
    const creator = new PublicKey(wallet);
    if (process.argv.includes("--track")) {
      await trackCreatorFees(conn, creator, process.env.SOLUM_FEE_STATE || "creator-fees.json", Number(process.env.SOLUM_FEE_POLL || 60));
    } else {
      const accrued = await getAccruedCreatorFees(conn, creator);
      console.log(`creator ${wallet}`);
      console.log(`accrued (unclaimed) creator fees: ${(accrued / LAMPORTS).toFixed(6)} SOL`);
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
