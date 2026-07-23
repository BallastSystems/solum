// Unit tests for the TWAB accumulator, snapshot builder, and winner lookup — pure, no validator.
// Proves the anti-gaming property: a last-second whale earns almost no tickets.

import { Keypair } from "@solana/web3.js";
import { TwabAccumulator, buildSnapshot, winnerOf } from "./twab";
import { verify } from "./merkle";

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });
const DEC = 6;
const T = 10n ** BigInt(DEC); // one whole token

function main() {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();

  // --- full-epoch holder: TWAB == balance ---
  {
    const acc = new TwabAccumulator(0);
    acc.update(a, 100n * T, 0);
    const twab = acc.finalize(3600);
    check("full-epoch holder TWAB equals balance", twab.get(a) === 100n * T, `${twab.get(a)}`);
  }

  // --- last-second whale earns ~1% of a full-epoch holder with the same balance ---
  {
    const acc = new TwabAccumulator(0);
    acc.update(a, 100n * T, 0); // holds 100 all hour
    acc.update(b, 0n, 0);
    acc.update(b, 100n * T, 3564); // buys 100 with 36s left (1% of the hour)
    const twab = acc.finalize(3600);
    const ta = twab.get(a)!, tb = twab.get(b)!;
    check("late whale gets ~1% weight", tb * 50n < ta, `full=${ta} late=${tb}`);
    check("late whale is non-zero but tiny", tb > 0n && tb < ta / 10n, `late=${tb}`);
  }

  // --- snapshot: ranges, total, and a verifiable root ---
  {
    const acc = new TwabAccumulator(0);
    acc.update(a, 100n * T, 0);
    acc.update(b, 300n * T, 0);
    const snap = buildSnapshot(acc.finalize(3600), DEC);
    check("total tickets = 100 + 300", snap.total === 400n, `${snap.total}`);
    check("contiguous ranges", snap.entries[0].start === 0n && snap.entries[1].start === snap.entries[0].tickets);
    // every entry's leaf verifies against the root
    let allVerify = true;
    snap.entries.forEach((e, i) => {
      const { proof } = winnerOf(snap, e.start); // proof for this entry's first ticket
      const leaf = require("./merkle").hashLeaf(e.owner, e.start, e.tickets);
      if (!verify(proof, snap.root, leaf)) allVerify = false;
    });
    check("every leaf verifies against the root", allVerify);
    // winner lookup lands in the right range
    const w = winnerOf(snap, snap.total - 1n);
    check("winner lookup finds the last-ticket holder", w.entry.start + w.entry.tickets === snap.total);
  }

  // --- odds scale linearly with holdings ---
  {
    const acc = new TwabAccumulator(0);
    acc.update(a, 50n * T, 0);
    acc.update(b, 150n * T, 0);
    const snap = buildSnapshot(acc.finalize(3600), DEC);
    const ea = snap.entries.find((e) => e.owner.toBase58() === a)!;
    const eb = snap.entries.find((e) => e.owner.toBase58() === b)!;
    check("3x holdings = 3x tickets", eb.tickets === ea.tickets * 3n, `${ea.tickets} vs ${eb.tickets}`);
  }

  console.log("\n=== solum :: twab / snapshot ===");
  let pass = 0;
  for (const r of results) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  — " + r.detail}`); if (r.ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  if (pass !== results.length) process.exit(1);
}
main();
