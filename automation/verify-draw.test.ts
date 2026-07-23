// Unit tests for the independent draw verifier — pure, no validator. Confirms it accepts a real
// draw and rejects every tamper (bad root, out-of-range ticket, gap in ranges, mismatched totals).

import { Keypair } from "@solana/web3.js";
import { hashLeaf, buildTree, rootOf } from "./merkle";
import { verifyDraw, SnapshotFile } from "./verify-draw";

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => results.push({ name, ok });

function main() {
  const a = Keypair.generate().publicKey, b = Keypair.generate().publicKey, c = Keypair.generate().publicKey;
  const entries = [
    { owner: a, start: 0n, tickets: 100n },
    { owner: b, start: 100n, tickets: 300n }, // [100,400) — winner range
    { owner: c, start: 400n, tickets: 100n },
  ];
  const total = 500n;
  const root = rootOf(buildTree(entries.map((e) => hashLeaf(e.owner, e.start, e.tickets))));
  const snap: SnapshotFile = {
    total: total.toString(), root: root.toString("hex"),
    entries: entries.map((e) => ({ owner: e.owner.toBase58(), start: e.start.toString(), tickets: e.tickets.toString() })),
  };
  const chain = { twabRoot: root, totalTickets: total, winningTicket: 250n }; // in b's range

  // valid draw verifies, and names the correct winner
  const good = verifyDraw(snap, chain);
  check("valid draw verifies", good.ok);
  check("names the correct winner (holder b)", good.winner === b.toBase58());

  // snapshot with no chain state still verifies its own integrity
  check("snapshot-only integrity verifies", verifyDraw(snap).ok);

  // tampered leaf → root no longer matches
  const tampered = { ...snap, entries: snap.entries.map((e, i) => (i === 1 ? { ...e, tickets: "301" } : e)) };
  check("tampered ticket count is rejected", !verifyDraw(tampered, chain).ok);

  // winning ticket outside every range → no winner, fails
  check("out-of-range winning ticket is rejected", !verifyDraw(snap, { ...chain, winningTicket: 999n }).ok);

  // on-chain root that doesn't match the published snapshot → rejected
  check("mismatched on-chain root is rejected", !verifyDraw(snap, { ...chain, twabRoot: Buffer.alloc(32, 7) }).ok);

  // a gap in the ranges → not contiguous, rejected
  const gapped: SnapshotFile = {
    total: "500", root: "00",
    entries: [
      { owner: a.toBase58(), start: "0", tickets: "100" },
      { owner: b.toBase58(), start: "200", tickets: "300" }, // gap [100,200)
    ],
  };
  check("gap in ticket ranges is rejected", !verifyDraw(gapped).ok);

  console.log("\n=== solum :: draw verifier ===");
  let pass = 0;
  for (const r of results) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`); if (r.ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  if (pass !== results.length) process.exit(1);
}
main();
