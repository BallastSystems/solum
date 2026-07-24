// Draw orchestration — turns a TWAB snapshot into an on-chain hourly draw:
//   commit_epoch(root, total)  →  settle (VRF)  →  claim_prize (auto-pay the proven winner).
// The winner never has to act; the bot pays them, and the program guarantees the pot can only
// reach the winning holder's own account.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, Transaction } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import { Randomness, Queue, getDefaultQueue, getDefaultDevnetQueue } from "@switchboard-xyz/on-demand";
import { randomBytes } from "crypto";
import { Snapshot, winnerOf } from "./twab";
import { toArray } from "./merkle";

export type JackpotRefs = {
  jackpot: PublicKey;
  jackpotAuthority: PublicKey;
  prizeMint: PublicKey;
  potCustody: PublicKey;
  prizeTokenProgram: PublicKey;
};

/** Post the epoch's TWAB Merkle root + total ticket count on-chain, opening the draw. */
export async function commitEpoch(prog: any, snapshotter: Keypair, refs: JackpotRefs, snap: Snapshot) {
  await prog.methods
    .commitEpoch(toArray(snap.root), new anchor.BN(snap.total.toString()))
    .accounts({ snapshotter: snapshotter.publicKey, jackpot: refs.jackpot })
    .signers([snapshotter])
    .rpc();
}

/**
 * Settle the draw. `devnet-vrf`: inject fresh CSPRNG randomness (local testing). `switchboard-vrf`:
 * call request_draw then settle_draw against a Switchboard randomness account (production) — wired
 * where noted. Fire this at a RANDOM moment inside the allowed window so the draw time is
 * unpredictable (see run.ts).
 */
export async function settleDevnet(prog: any, snapshotter: Keypair, refs: JackpotRefs) {
  const rand = randomBytes(32);
  await prog.methods
    .settleDraw(toArray(rand))
    .accounts({ snapshotter: snapshotter.publicKey, jackpot: refs.jackpot })
    .signers([snapshotter])
    .rpc();
}

// ─── switchboard-vrf: production randomness path ────────────────────────────────────────────────
// The full flow is wired here (commit + request_draw in one slot → oracle reveal → reveal + settle),
// but it can only be SMOKE-TESTED against a funded devnet/mainnet with a live Switchboard oracle — a
// bare local validator has no oracle. Also needs the production (switchboard-vrf) IDL loaded, and may
// need an address-lookup-table if the commit+request tx exceeds size. Verify live before relying on it.

/** The default Switchboard On-Demand queue for this cluster (devnet vs mainnet). */
export async function loadSwitchboardQueue(conn: Connection): Promise<Queue> {
  const rpc = (conn as any)._rpcEndpoint as string;
  return /devnet|testnet|localhost|127\.0\.0\.1/.test(rpc) ? getDefaultDevnetQueue(rpc) : getDefaultQueue(rpc);
}

/** Create + commit a fresh randomness account and bind it to the epoch in ONE tx — request_draw
 * requires the commitment's seed_slot == the current slot, so commit and request must share a slot. */
export async function requestDrawVrf(
  prog: any, queue: Queue, ops: Keypair, refs: JackpotRefs, conn: Connection,
): Promise<Randomness> {
  const [randomness, rndKp, ccIxs] = await Randomness.createAndCommitIxs(queue.program as any, queue.pubkey, ops.publicKey);
  const requestIx = await prog.methods
    .requestDraw()
    .accounts({ caller: ops.publicKey, jackpot: refs.jackpot, randomness: randomness.pubkey })
    .instruction();
  const sig = await conn.sendTransaction(new Transaction().add(...ccIxs, requestIx), [ops, rndKp]);
  await conn.confirmTransaction(sig, "confirmed");
  return randomness;
}

/** Reveal the oracle value + settle the draw in one tx, retrying until the oracle has revealed. */
export async function settleDrawVrf(
  prog: any, randomness: Randomness, ops: Keypair, refs: JackpotRefs, conn: Connection, tries = 30,
): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const revealIx = await randomness.revealIx(ops.publicKey);
      const settleIx = await prog.methods
        .settleDraw()
        .accounts({ caller: ops.publicKey, jackpot: refs.jackpot, randomness: randomness.pubkey })
        .instruction();
      const sig = await conn.sendTransaction(new Transaction().add(revealIx, settleIx), [ops]);
      await conn.confirmTransaction(sig, "confirmed");
      return;
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000)); // oracle not revealed yet — wait + retry
    }
  }
}

/** Read the settled winning ticket from on-chain state. */
export async function winningTicketOf(prog: any, refs: JackpotRefs): Promise<bigint> {
  const j = await prog.account.jackpotState.fetch(refs.jackpot);
  return BigInt(j.winningTicket.toString());
}

/** Find the winner from the snapshot and pay them the whole pot (permissionless, auto-creating their ATA). */
export async function payWinner(
  prog: any,
  caller: Keypair,
  refs: JackpotRefs,
  snap: Snapshot,
  winningTicket: bigint,
  conn: Connection,
): Promise<{ winner: PublicKey; tickets: bigint; sig: string }> {
  const { entry, proof } = winnerOf(snap, winningTicket);
  const ata = await getOrCreateAssociatedTokenAccount(
    conn, caller, refs.prizeMint, entry.owner, false, undefined, undefined, refs.prizeTokenProgram,
  );
  const sig = await prog.methods
    .claimPrize(new anchor.BN(entry.start.toString()), new anchor.BN(entry.tickets.toString()), proof.map(toArray))
    .accounts({
      caller: caller.publicKey,
      winner: entry.owner,
      jackpot: refs.jackpot,
      jackpotAuthority: refs.jackpotAuthority,
      prizeMint: refs.prizeMint,
      potCustody: refs.potCustody,
      winnerPrizeAccount: ata.address,
      prizeTokenProgram: refs.prizeTokenProgram,
    })
    .signers([caller])
    .rpc();
  return { winner: entry.owner, tickets: entry.tickets, sig };
}

/** One full devnet draw: commit → settle → pay. Assumes the epoch has already elapsed on-chain. */
export async function runDrawDevnet(
  prog: any,
  ops: Keypair,
  refs: JackpotRefs,
  snap: Snapshot,
  conn: Connection,
): Promise<{ winningTicket: bigint; winner: PublicKey; tickets: bigint }> {
  await commitEpoch(prog, ops, refs, snap);
  await settleDevnet(prog, ops, refs);
  const winningTicket = await winningTicketOf(prog, refs);
  const paid = await payWinner(prog, ops, refs, snap, winningTicket, conn);
  return { winningTicket, ...paid };
}
