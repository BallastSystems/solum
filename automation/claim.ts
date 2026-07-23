// Claim + award — the two halves of the reward flow.
//
// Model (operator-chosen): each hour a winner is drawn on-chain (provably fair). The winner's Claim
// button is available right away. When they click it and sign, we RECORD the claim (registerClaim) —
// this is required to be paid, and it starts a 24-hour window. The operator then MANUALLY sends the
// tokenized-stock prize from the review wallet within that window (awardPrize). No automatic payout.
//
// registerClaim  — winner-initiated, signature-gated, records claimed + claimedAt (no funds move).
// awardPrize     — operator-run, sends the exact prize to a claimed winner and marks it awarded.
//
// The ops/custody key lives only in the service/CLI environment — never in the repo or the site.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transferChecked, getMint } from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import * as fs from "fs";
import { WinnerEntry } from "./status";

export type ClaimConfig = {
  conn: Connection;
  ops: Keypair; // the review/custody wallet — holds the stock and signs the award
  stockMint: PublicKey;
  stockProgram: PublicKey; // Token-2022 for xStocks
  opsStockAccount: PublicKey; // the ops wallet's stock token account (source of the award)
  winnersFile: string; // the published record + source of truth for claimed/awarded state
  awardWindowMs?: number; // the operator's delivery SLA, shown to the winner (default 24h)
  freshnessMs?: number; // how recent the signed message must be (default 15 min) — anti-replay
};

export type ClaimRequest = { epoch: number; winner: string; message: string; signature: string };
export type ClaimResult =
  | { ok: true; claimedAt: string; awardWithin: string; alreadyClaimed?: boolean }
  | { ok: false; reason: string };
export type AwardResult =
  | { ok: true; awardTx: string; alreadyAwarded?: boolean }
  | { ok: false; reason: string };

// The exact message a winner signs to claim. Binds the epoch and a timestamp (freshness/anti-replay).
export const claimMessage = (epoch: number, iso: string) => `Solum claim | epoch ${epoch} | ${iso}`;
const MSG_RE = /^Solum claim \| epoch (\d+) \| (.+)$/;

const awarding = new Set<number>(); // per-epoch lock so an award is never sent twice

function verifySig(winner: PublicKey, message: string, signatureB58: string): boolean {
  try {
    return ed25519.verify(bs58.decode(signatureB58), new TextEncoder().encode(message), winner.toBytes());
  } catch {
    return false;
  }
}
function readWinners(file: string): WinnerEntry[] {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as WinnerEntry[];
  } catch {
    return [];
  }
}
function writeWinners(file: string, arr: WinnerEntry[]): void {
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
}

/** Winner-initiated: verify the signed claim and record it. No funds move. Claiming is required to
 * be paid and starts the operator's delivery window. Idempotent. */
export function registerClaim(cfg: ClaimConfig, req: ClaimRequest): ClaimResult {
  const windowMs = cfg.awardWindowMs ?? 24 * 3600 * 1000;
  const freshMs = cfg.freshnessMs ?? 15 * 60 * 1000;

  let winner: PublicKey;
  try {
    winner = new PublicKey(req.winner);
  } catch {
    return { ok: false, reason: "invalid winner address" };
  }

  // signature must verify, bind to this epoch, and be recent (anti-replay)
  const m = MSG_RE.exec(req.message || "");
  if (!m || Number(m[1]) !== req.epoch) return { ok: false, reason: "claim message does not match the request" };
  const ts = Date.parse(m[2]);
  if (!isFinite(ts) || Math.abs(Date.now() - ts) > freshMs)
    return { ok: false, reason: "claim signature expired — please sign again" };
  if (!verifySig(winner, req.message, req.signature)) return { ok: false, reason: "signature does not verify" };

  const arr = readWinners(cfg.winnersFile);
  const idx = arr.findIndex((w) => w.epoch === req.epoch);
  if (idx < 0) return { ok: false, reason: "no draw found for that epoch" };
  const e = arr[idx];
  if (e.addr !== req.winner) return { ok: false, reason: "this wallet did not win that draw" };

  const withinOf = (claimedIso: string) => new Date(Date.parse(claimedIso) + windowMs).toISOString();
  if (e.awarded) return { ok: true, claimedAt: e.claimedAt || e.drawAt, awardWithin: withinOf(e.claimedAt || e.drawAt), alreadyClaimed: true };
  if (e.claimed && e.claimedAt) return { ok: true, claimedAt: e.claimedAt, awardWithin: withinOf(e.claimedAt), alreadyClaimed: true };

  const claimedAt = new Date().toISOString();
  arr[idx].claimed = true;
  arr[idx].claimedAt = claimedAt;
  writeWinners(cfg.winnersFile, arr);
  return { ok: true, claimedAt, awardWithin: withinOf(claimedAt) };
}

/** Operator-run: send the exact prize from the ops wallet to a claimed winner and mark it awarded.
 * Only pays a winner who has claimed and has not been paid. Idempotent, single-send-locked. */
export async function awardPrize(cfg: ClaimConfig, epoch: number): Promise<AwardResult> {
  const arr = readWinners(cfg.winnersFile);
  const e = arr.find((w) => w.epoch === epoch);
  if (!e) return { ok: false, reason: "no draw found for that epoch" };
  if (e.awarded) return { ok: true, awardTx: e.awardTx || e.payoutTx || "", alreadyAwarded: true };
  if (!e.claimed) return { ok: false, reason: "winner has not claimed yet — nothing to award" };
  const amount = BigInt(e.prizeBaseUnits || "0");
  if (amount <= 0n) return { ok: false, reason: "prize amount is unavailable for that draw" };

  if (awarding.has(epoch)) return { ok: false, reason: "this award is already being sent" };
  awarding.add(epoch);
  try {
    const fresh = readWinners(cfg.winnersFile).find((w) => w.epoch === epoch);
    if (fresh?.awarded) return { ok: true, awardTx: fresh.awardTx || "", alreadyAwarded: true };

    const winner = new PublicKey(e.addr);
    const dec = (await getMint(cfg.conn, cfg.stockMint, undefined, cfg.stockProgram)).decimals;
    const winnerAta = await getOrCreateAssociatedTokenAccount(
      cfg.conn, cfg.ops, cfg.stockMint, winner, false, undefined, undefined, cfg.stockProgram,
    );
    const sig = await transferChecked(
      cfg.conn, cfg.ops, cfg.opsStockAccount, cfg.stockMint, winnerAta.address, cfg.ops,
      amount, dec, [], undefined, cfg.stockProgram,
    );

    const latest = readWinners(cfg.winnersFile);
    const li = latest.findIndex((w) => w.epoch === epoch);
    if (li >= 0) {
      latest[li].awarded = true;
      latest[li].awardTx = sig;
      latest[li].payoutTx = sig; // legacy alias for the recent-winners feed
      writeWinners(cfg.winnersFile, latest);
    }
    return { ok: true, awardTx: sig };
  } catch (err: any) {
    return { ok: false, reason: "award failed: " + (err?.message || String(err)) };
  } finally {
    awarding.delete(epoch);
  }
}
