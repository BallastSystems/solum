// Draw orchestration — turns a TWAB snapshot into an on-chain hourly draw:
//   commit_epoch(root, total)  →  settle (VRF)  →  claim_prize (auto-pay the proven winner).
// The winner never has to act; the bot pays them, and the program guarantees the pot can only
// reach the winning holder's own account.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
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
): Promise<{ winner: PublicKey; tickets: bigint }> {
  const { entry, proof } = winnerOf(snap, winningTicket);
  const ata = await getOrCreateAssociatedTokenAccount(
    conn, caller, refs.prizeMint, entry.owner, false, undefined, undefined, refs.prizeTokenProgram,
  );
  await prog.methods
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
  return { winner: entry.owner, tickets: entry.tickets };
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
