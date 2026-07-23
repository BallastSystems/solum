// Merkle tree over jackpot ticket leaves — MUST mirror the on-chain hash_leaf / hash_node exactly
// (keccak256, 0x00 leaf / 0x01 sorted-node domain tags). The snapshotter builds the tree and posts
// only the root on-chain; the program verifies each winner's proof against it.

import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3";

export const u64le = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

/** H(0x00 || owner || start_le || tickets_le) */
export const hashLeaf = (owner: PublicKey, start: bigint, tickets: bigint): Buffer =>
  Buffer.from(keccak_256(Buffer.concat([Buffer.from([0]), owner.toBuffer(), u64le(start), u64le(tickets)])));

/** H(0x01 || sorted(a, b)) */
export const hashNode = (a: Buffer, b: Buffer): Buffer => {
  const [x, y] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak_256(Buffer.concat([Buffer.from([1]), x, y])));
};

/** Build all tree layers (leaves at [0], root at [len-1][0]). Odd nodes are promoted. */
export function buildTree(leaves: Buffer[]): Buffer[][] {
  if (leaves.length === 0) throw new Error("cannot build a Merkle tree with no leaves");
  const layers: Buffer[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashNode(cur[i], cur[i + 1]) : cur[i]);
    layers.push(next);
  }
  return layers;
}

export const rootOf = (layers: Buffer[][]): Buffer => layers[layers.length - 1][0];

/** The sibling proof for the leaf at `index`. */
export function proofFor(layers: Buffer[][], index: number): Buffer[] {
  const p: Buffer[] = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sib = idx ^ 1;
    if (sib < layer.length) p.push(layer[sib]);
    idx = Math.floor(idx / 2);
  }
  return p;
}

/** Sorted-pair verify — the same fold the program runs. Useful for self-checks. */
export function verify(proof: Buffer[], root: Buffer, leaf: Buffer): boolean {
  let computed = leaf;
  for (const p of proof) computed = hashNode(computed, p);
  return Buffer.compare(computed, root) === 0;
}

export const toArray = (b: Buffer): number[] => Array.from(b);
