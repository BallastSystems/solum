// Probe: land a Switchboard randomness commit on mainnet and measure seed_slot vs the slot it
// executed in, to pin down the exact offset our on-chain request_draw must check. Read-only w.r.t.
// Solum (touches no jackpot); just creates+commits a throwaway randomness account (~0.002 SOL).
import * as anchor from "@coral-xyz/anchor";
import { Connection, Transaction } from "@solana/web3.js";
import { Randomness } from "@switchboard-xyz/on-demand";
import { loadSwitchboardQueue } from "./draw";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn: Connection = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer;
  const queue = await loadSwitchboardQueue(conn);
  console.log("queue:", queue.pubkey.toBase58());

  const [randomness, rndKp, ccIxs] = await Randomness.createAndCommitIxs(queue.program as any, queue.pubkey, ops.publicKey);
  // land the commit ALONE, skip preflight (seed-slot logic isn't simulatable)
  const sig = await conn.sendTransaction(new Transaction().add(...ccIxs), [ops, rndKp], { skipPreflight: true });
  const conf = await conn.confirmTransaction(sig, "confirmed");
  const txSlot = (conf as any).context?.slot;
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const landedSlot = tx?.slot;
  const data = await randomness.loadData();
  const seedSlot = (data as any).seedSlot.toNumber();
  const nowSlot = await conn.getSlot("confirmed");
  console.log(`commit sig     : ${sig}`);
  console.log(`landed in slot : ${landedSlot}`);
  console.log(`seed_slot      : ${seedSlot}`);
  console.log(`offset (seed_slot - landed_slot) : ${landedSlot != null ? seedSlot - landedSlot : "?"}`);
  console.log(`current slot   : ${nowSlot}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
