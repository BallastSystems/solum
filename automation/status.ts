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

export const iso = (unixSec: number) => new Date(unixSec * 1000).toISOString();
export const hourLabel = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleString("en-US", { hour: "numeric", hour12: true });
