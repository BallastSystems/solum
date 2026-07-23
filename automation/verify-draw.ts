// Independent draw verifier — the "check it yourself" tool behind the site's proof claims.
//
// Given a published epoch snapshot (the full list of holders + tickets) and the on-chain jackpot
// state, it re-derives the Merkle root from scratch and confirms the winning ticket maps to exactly
// one holder — so anyone can verify a draw was fair without trusting the operator.
//
//   node verify-draw.js <snapshot.json>     (reads RPC + jackpot from env; see bottom)

import { PublicKey } from "@solana/web3.js";
import { hashLeaf, buildTree, rootOf } from "./merkle";

export type SnapshotFile = {
  total: string;
  root: string; // hex
  entries: { owner: string; start: string; tickets: string }[];
};
export type OnchainDraw = { twabRoot: Buffer; totalTickets: bigint; winningTicket: bigint };

const hex = (s: string) => s.replace(/^0x/, "").toLowerCase();

/** Re-derive everything from the published snapshot (+ optional on-chain state) and return the checks. */
export function verifyDraw(snap: SnapshotFile, chain?: OnchainDraw) {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  const entries = snap.entries.map((e) => ({
    owner: new PublicKey(e.owner), start: BigInt(e.start), tickets: BigInt(e.tickets),
  }));

  // 1. re-derive the Merkle root from the published leaves — must match what was committed
  const recomputed = rootOf(buildTree(entries.map((e) => hashLeaf(e.owner, e.start, e.tickets))));
  add("Merkle root re-derives from the published snapshot", recomputed.toString("hex") === hex(snap.root),
    `recomputed ${recomputed.toString("hex").slice(0, 16)}…`);

  // 2. ticket ranges are contiguous from 0 with no gaps or overlaps, and sum to the stated total
  const sorted = [...entries].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  let cursor = 0n, contiguous = true;
  for (const e of sorted) { if (e.start !== cursor || e.tickets <= 0n) contiguous = false; cursor += e.tickets; }
  add("ticket ranges are contiguous, positive, no gaps or overlaps", contiguous);
  add("ticket total matches the snapshot", cursor === BigInt(snap.total), `sum ${cursor} vs total ${snap.total}`);

  let winner: string | null = null;
  if (chain) {
    add("on-chain committed root matches the snapshot", chain.twabRoot.toString("hex") === hex(snap.root));
    add("on-chain total_tickets matches the snapshot", chain.totalTickets === BigInt(snap.total));
    const w = sorted.find((e) => chain.winningTicket >= e.start && chain.winningTicket < e.start + e.tickets);
    add("winning ticket falls in exactly one holder's range", !!w, `ticket ${chain.winningTicket}`);
    winner = w ? w.owner.toBase58() : null;
  }
  return { ok: checks.every((c) => c.ok), checks, winner };
}

// ---- CLI ----
if (require.main === module) {
  (async () => {
    const fs = await import("fs");
    const anchor = await import("@coral-xyz/anchor");
    const { Connection, Keypair } = await import("@solana/web3.js");
    const snapPath = process.argv[2];
    if (!snapPath) { console.error("usage: node verify-draw.js <snapshot.json>"); process.exit(2); }
    const snap: SnapshotFile = JSON.parse(fs.readFileSync(snapPath, "utf8"));

    let chain: OnchainDraw | undefined;
    if (process.env.SOLUM_JACKPOT) {
      const rpc = process.env.SOLUM_RPC || "https://api.devnet.solana.com";
      const idl = JSON.parse(fs.readFileSync(process.env.SOLUM_IDL || "target/idl/solum.json", "utf8"));
      const provider = new anchor.AnchorProvider(new Connection(rpc, "confirmed"), new anchor.Wallet(Keypair.generate()), {});
      const prog = new anchor.Program(idl, provider);
      const j: any = await (prog.account as any).jackpotState.fetch(new PublicKey(process.env.SOLUM_JACKPOT));
      chain = { twabRoot: Buffer.from(j.twabRoot), totalTickets: BigInt(j.totalTickets.toString()), winningTicket: BigInt(j.winningTicket.toString()) };
    }

    const res = verifyDraw(snap, chain);
    console.log("\n=== verify draw ===");
    for (const c of res.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`);
    if (res.winner) console.log(`  winner: ${res.winner}`);
    console.log(res.ok ? "\n✅ draw verifies" : "\n❌ verification failed");
    process.exit(res.ok ? 0 : 1);
  })();
}
