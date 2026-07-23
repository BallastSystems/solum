// Claim fulfillment — the "send the prize from the review wallet to the winner" step.
//
// Model: each hour a winner is drawn on-chain (provably fair) and the tokenized-stock prize is held
// in the operator's review (ops) wallet through a 24-hour quality-control hold. When the countdown
// ends, the winner connects their wallet on the site, signs a short claim message, and this service
// verifies everything and sends the exact prize from the ops wallet straight to them.
//
// It pays ONLY the on-chain-proven winner, ONLY after the 24h hold, ONLY once, and only the exact
// recorded amount. The winner's own signature is required, so a claim is always winner-initiated.
// The ops key lives only in the service's environment — never in the repo or the site.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, transferChecked, getMint } from "@solana/spl-token";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import * as fs from "fs";
import { WinnerEntry } from "./status";

export type ClaimConfig = {
  conn: Connection;
  ops: Keypair; // the review/custody wallet — holds the stock and signs the payout
  stockMint: PublicKey;
  stockProgram: PublicKey; // Token-2022 for xStocks
  opsStockAccount: PublicKey; // the ops wallet's stock token account (source of the payout)
  winnersFile: string; // the published record (also the source of truth for claimed state)
  holdMs?: number; // QC hold before a claim is allowed (default 24h)
  freshnessMs?: number; // how recent the signed message must be (default 15 min) — anti-replay
};

export type ClaimRequest = { epoch: number; winner: string; message: string; signature: string };
export type ClaimResult =
  | { ok: true; claimTx: string; alreadyClaimed?: boolean }
  | { ok: false; reason: string };

// The exact message a winner signs to claim. Binds the epoch and a timestamp (freshness/anti-replay).
export const claimMessage = (epoch: number, iso: string) => `Solum claim | epoch ${epoch} | ${iso}`;
const MSG_RE = /^Solum claim \| epoch (\d+) \| (.+)$/;

const inFlight = new Set<number>(); // per-epoch lock: never send twice for the same draw

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

/** Verify a claim end-to-end and, if valid, send the prize from the ops wallet to the winner. */
export async function fulfillClaim(cfg: ClaimConfig, req: ClaimRequest): Promise<ClaimResult> {
  const holdMs = cfg.holdMs ?? 24 * 3600 * 1000;
  const freshMs = cfg.freshnessMs ?? 15 * 60 * 1000;

  let winner: PublicKey;
  try {
    winner = new PublicKey(req.winner);
  } catch {
    return { ok: false, reason: "invalid winner address" };
  }

  // 1) signature must verify, bind to this epoch, and be recent (anti-replay)
  const m = MSG_RE.exec(req.message || "");
  if (!m || Number(m[1]) !== req.epoch) return { ok: false, reason: "claim message does not match the request" };
  const ts = Date.parse(m[2]);
  if (!isFinite(ts) || Math.abs(Date.now() - ts) > freshMs)
    return { ok: false, reason: "claim signature expired — please sign again" };
  if (!verifySig(winner, req.message, req.signature)) return { ok: false, reason: "signature does not verify" };

  // 2) find the draw and confirm this wallet actually won it
  const arr = readWinners(cfg.winnersFile);
  const e = arr.find((w) => w.epoch === req.epoch);
  if (!e) return { ok: false, reason: "no draw found for that epoch" };
  if (e.addr !== req.winner) return { ok: false, reason: "this wallet did not win that draw" };

  // 3) the 24-hour review hold must have elapsed (server-side clock, not the client's)
  const claimableAt = e.claimableAt ? Date.parse(e.claimableAt) : Date.parse(e.drawAt) + holdMs;
  if (Date.now() < claimableAt) return { ok: false, reason: "the 24-hour review hold has not ended yet" };

  // 4) idempotent — already paid
  if (e.claimed) return { ok: true, claimTx: e.claimTx || e.payoutTx || "", alreadyClaimed: true };

  const amount = BigInt(e.prizeBaseUnits || "0");
  if (amount <= 0n) return { ok: false, reason: "prize amount is unavailable for that draw" };

  // 5) lock this epoch so two concurrent requests can't double-send
  if (inFlight.has(req.epoch)) return { ok: false, reason: "this claim is already being processed" };
  inFlight.add(req.epoch);
  try {
    // re-read right before paying (guards a claim that landed between step 4 and here)
    const fresh = readWinners(cfg.winnersFile).find((w) => w.epoch === req.epoch);
    if (fresh?.claimed) return { ok: true, claimTx: fresh.claimTx || "", alreadyClaimed: true };

    // 6) send the exact prize from the ops wallet → the winner's own token account
    const dec = (await getMint(cfg.conn, cfg.stockMint, undefined, cfg.stockProgram)).decimals;
    const winnerAta = await getOrCreateAssociatedTokenAccount(
      cfg.conn, cfg.ops, cfg.stockMint, winner, false, undefined, undefined, cfg.stockProgram,
    );
    const sig = await transferChecked(
      cfg.conn, cfg.ops, cfg.opsStockAccount, cfg.stockMint, winnerAta.address, cfg.ops,
      amount, dec, [], undefined, cfg.stockProgram,
    );

    // 7) persist the claim (re-read latest, stamp, write) so the site shows "Claimed ✓ + tx"
    const latest = readWinners(cfg.winnersFile);
    const li = latest.findIndex((w) => w.epoch === req.epoch);
    if (li >= 0) {
      latest[li].claimed = true;
      latest[li].claimTx = sig;
      latest[li].payoutTx = sig; // legacy alias for the recent-winners feed
      fs.writeFileSync(cfg.winnersFile, JSON.stringify(latest, null, 2));
    }
    return { ok: true, claimTx: sig };
  } catch (err: any) {
    return { ok: false, reason: "payout failed: " + (err?.message || String(err)) };
  } finally {
    inFlight.delete(req.epoch);
  }
}
