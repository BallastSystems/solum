// Draw-status publisher. The bot writes this JSON each phase; the site fetches it (as
// solum.work/status.json) to show "snapshot taken / drawing at X / winner" in real time.

import * as fs from "fs";
import * as path from "path";

export type DrawStatus = {
  updatedAt: string; // ISO
  hourLabel: string; // e.g. "3 PM"
  phase: "collecting" | "snapshot_taken" | "drawn";
  snapshotAt: string | null; // ISO — only set once the snapshot is actually taken (hidden before)
  drawAt: string | null; // ISO — the randomized draw time, revealed only after the snapshot
  holders: number;
  potUsd: number;
  lastWinner: { addr: string; prizeUsd: number; stock: string; drawAt: string } | null;
};

export function writeStatus(outFile: string, s: Omit<DrawStatus, "updatedAt">): void {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const full: DrawStatus = { ...s, updatedAt: new Date().toISOString() };
  fs.writeFileSync(outFile, JSON.stringify(full, null, 2));
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
  prizeUsd: number;
  drawAt: string; // ISO — the precise settle time
  claimableAt: string; // ISO — drawAt + 24h; the prize is held in the review wallet until then
  claimed: boolean; // set true once the winner has claimed and the stock has been sent to them
  claimTx: string | null; // the transfer signature from the review wallet to the winner (once claimed)
  payoutTx: string; // legacy alias for claimTx (kept for the site's recent-winners feed); "" until claimed
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
