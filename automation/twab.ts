// Time-Weighted Average Balance (TWAB) accumulator — the anti-exploit core of the raffle.
//
// A holder's tickets for an epoch are their AVERAGE $SOLUM balance over the whole hour, not their
// balance at one instant. This is what makes the snapshot un-gameable: buying a huge bag one second
// before the draw yields ~one second of weight out of 3600, not a full allocation. (PoolTogether's
// exact primitive.) Combined with a random draw time, timing the draw is worthless.
//
// Feed it every balance change during the epoch (from token-transfer events); finalize at epoch end.

import { PublicKey } from "@solana/web3.js";
import { hashLeaf, buildTree, rootOf, proofFor, u64le } from "./merkle";

export class TwabAccumulator {
  private bal = new Map<string, bigint>(); // current base-unit balance
  private lastT = new Map<string, number>(); // last update time (unix seconds)
  private acc = new Map<string, bigint>(); // Σ balance · dt  (base-units · seconds)

  constructor(private epochStart: number) {}

  /** Record `holder`'s new balance at time `t` (seconds). Fold the elapsed segment first. */
  update(holder: string, newBalance: bigint, t: number): void {
    this.fold(holder, t);
    this.bal.set(holder, newBalance < 0n ? 0n : newBalance);
  }

  private fold(holder: string, t: number): void {
    const b = this.bal.get(holder) ?? 0n;
    const last = this.lastT.get(holder) ?? this.epochStart;
    const dt = BigInt(Math.max(0, t - last));
    this.acc.set(holder, (this.acc.get(holder) ?? 0n) + b * dt);
    this.lastT.set(holder, t);
  }

  /** TWAB (base units) per holder at epoch end. */
  finalize(epochEnd: number): Map<string, bigint> {
    const dur = BigInt(Math.max(1, epochEnd - this.epochStart));
    const out = new Map<string, bigint>();
    for (const h of this.bal.keys()) {
      this.fold(h, epochEnd);
      out.set(h, (this.acc.get(h) ?? 0n) / dur);
    }
    return out;
  }
}

export type Entry = { owner: PublicKey; start: bigint; tickets: bigint };
export type Snapshot = {
  entries: Entry[];
  total: bigint;
  root: Buffer;
  layers: Buffer[][];
  indexOf: Map<string, number>;
};

/**
 * Turn a TWAB map into ticket ranges + a Merkle tree. Tickets = TWAB scaled to whole tokens (so
 * odds are "average whole-$SOLUM held"), linear in balance (splitting across wallets is neutral).
 * Holders below one whole token get no ticket. Sorted by pubkey for a deterministic, verifiable tree.
 */
export function buildSnapshot(twab: Map<string, bigint>, decimals: number): Snapshot {
  const scale = 10n ** BigInt(decimals);
  const holders = [...twab.entries()]
    .map(([k, v]) => ({ owner: new PublicKey(k), tickets: v / scale }))
    .filter((h) => h.tickets > 0n)
    .sort((a, b) => (a.owner.toBase58() < b.owner.toBase58() ? -1 : 1));

  if (holders.length === 0) throw new Error("no eligible holders (every TWAB below one token)");

  let cursor = 0n;
  const entries: Entry[] = [];
  const indexOf = new Map<string, number>();
  holders.forEach((h, i) => {
    entries.push({ owner: h.owner, start: cursor, tickets: h.tickets });
    indexOf.set(h.owner.toBase58(), i);
    cursor += h.tickets;
  });

  const leaves = entries.map((e) => hashLeaf(e.owner, e.start, e.tickets));
  const layers = buildTree(leaves);
  return { entries, total: cursor, root: rootOf(layers), layers, indexOf };
}

/** The entry (and its Merkle proof) whose ticket range contains `winningTicket`. */
export function winnerOf(snap: Snapshot, winningTicket: bigint): { entry: Entry; proof: Buffer[] } {
  const idx = snap.entries.findIndex((e) => winningTicket >= e.start && winningTicket < e.start + e.tickets);
  if (idx < 0) throw new Error(`winning ticket ${winningTicket} out of range (total ${snap.total})`);
  return { entry: snap.entries[idx], proof: proofFor(snap.layers, idx) };
}

export { u64le };
