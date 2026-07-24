// Draw-status publisher. The bot writes this JSON each phase; the site fetches it (as
// solum.work/status.json) to show "snapshot taken / drawing at X / winner" in real time.

import * as fs from "fs";
import * as path from "path";

export type DrawStatus = {
  updatedAt: string; // ISO
  hourLabel: string; // e.g. "3 PM"
  phase: "collecting" | "snapshot_taken" | "drawn";
  snapshotAt: string | null; // ISO — only set once the snapshot is actually taken (hidden before)
  drawAt: string | null; // ISO — the draw time (snapshot + a fixed 5-min countdown), set once the snapshot is taken
  holders: number;
  potUsd: number; // this cycle's creator fees → the pot allotted to the NEXT draw (since the last snapshot)
  prize: { stock: string; shares: number; usd: number; buyTx?: string } | null; // the stock bought AT the snapshot for THIS draw (buyTx = the swap sig, proof of purchase)
  feesLifetimeUsd: number; // total creator fees collected all-time  (= prizesAwardedUsd + potUsd)
  prizesAwardedUsd: number; // total raffled to holders all-time (what's been given out)
  fees24hUsd: number; // creator fees collected in the last 24 hours
  lastWinner: { addr: string; prizeUsd: number; stock: string; drawAt: string } | null;
};

export function writeStatus(outFile: string, s: Omit<DrawStatus, "updatedAt">): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const full: DrawStatus = { ...s, updatedAt: new Date().toISOString() };
  fs.writeFileSync(outFile, JSON.stringify(full, null, 2));
}

/** Derive the creator-fee ledger from the published winners record + this cycle's pot. Every figure
 * reconciles: feesLifetime = prizesAwarded (given out) + potUsd (building for the next draw). It's
 * restart-safe and auditable because it's summed straight from the immutable winners.json. */
export function feeLedger(
  winnersFile: string,
  potUsd: number,
): { feesLifetimeUsd: number; prizesAwardedUsd: number; fees24hUsd: number } {
  let arr: WinnerEntry[] = [];
  try {
    arr = JSON.parse(fs.readFileSync(winnersFile, "utf8"));
  } catch {
    /* first run — no winners yet */
  }
  const now = Date.now();
  const awarded = arr.reduce((sum, w) => sum + (w.prizeUsd || 0), 0);
  const last24 = arr
    .filter((w) => now - Date.parse(w.drawAt) <= 24 * 3600 * 1000)
    .reduce((sum, w) => sum + (w.prizeUsd || 0), 0);
  return {
    prizesAwardedUsd: awarded,
    feesLifetimeUsd: awarded + potUsd,
    fees24hUsd: last24 + potUsd,
  };
}

export type WinnerEntry = {
  epoch: number; // draw number (hour index) — stable id for the winner in the public register
  hourLabel: string;
  addr: string;
  solumHeld: number; // the winner's time-averaged whole-$SOLUM balance over the hour (= their tickets)
  totalTickets: number; // the hour's whole ticket pool — win odds = solumHeld / totalTickets
  holders: number; // eligible holders in the draw
  stock: string;
  prizeShares: number; // whole tokenized-stock shares won (the entire pot)
  prizeBaseUnits: string; // exact token base-unit amount owed — what the claim service pays out
  prizeUsd: number;
  drawAt: string; // ISO — the precise settle time
  claimed: boolean; // the winner clicked Claim (acknowledged) — claiming is required to be paid
  claimedAt: string | null; // ISO — when they claimed; the 24h delivery window runs from here
  awarded: boolean; // the operator has manually sent the prize to the winner
  awardTx: string | null; // the delivery transfer signature (review wallet -> winner)
  payoutTx: string; // legacy alias for awardTx (kept for the site's recent-winners feed); "" until awarded
};

/** Prepend a winner to the rolling history the site reads (as solum.work/winners.json). */
export function appendWinner(file: string, w: WinnerEntry, keep = 48): void {
  let arr: WinnerEntry[] = [];
  try { arr = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run */ }
  arr.unshift(w);
  arr = arr.slice(0, keep);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
}

export const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString();
export const hourLabel = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleString("en-US", { hour: "numeric", hour12: true });
