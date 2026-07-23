// Full-cycle draw test on a validator, driven by the bot's own orchestrator (draw.ts):
// build a TWAB snapshot → commit → settle (devnet-vrf) → auto-pay the proven winner. Runs several
// draws to show it repeats and that the winner is always the holder whose range holds the ticket.
//
// Run with: ANCHOR_PROVIDER_URL + ANCHOR_WALLET set, against the deployed program.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, mintTo,
  createAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { TwabAccumulator, buildSnapshot, winnerOf } from "./twab";
import { commitEpoch, settleDevnet, winningTicketOf, payWinner, JackpotRefs } from "./draw";

const CP = TOKEN_PROGRAM_ID, RP = TOKEN_2022_PROGRAM_ID;
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push({ name, ok, detail });
const bal = async (conn: any, ata: PublicKey) => Number((await getAccount(conn, ata, undefined, RP)).amount);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer; // creator + snapshotter + payer
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);

  const coin = await createMint(conn, ops, ops.publicKey, null, 6, undefined, undefined, CP);
  const prize = await createMint(conn, ops, ops.publicKey, null, 6, undefined, undefined, RP);
  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), ops.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const potCustody = await createAssociatedTokenAccount(conn, ops, prize, jAuth, {}, RP, undefined, true);

  const EPOCH_LEN = 1;
  await prog.methods.initJackpot(new anchor.BN(EPOCH_LEN)).accounts({
    admin: ops.publicKey, coinMint: coin, prizeMint: prize, snapshotter: ops.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody, systemProgram: SystemProgram.programId,
  }).rpc();
  check("init_jackpot", true);

  const refs: JackpotRefs = { jackpot, jackpotAuthority: jAuth, prizeMint: prize, potCustody, prizeTokenProgram: RP };

  // three holders with real balances → TWAB snapshot (held the full epoch)
  const holders = await Promise.all([100, 300, 600].map(async (whole) => {
    const kp = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL), "confirmed");
    return { kp, whole };
  }));
  const acc = new TwabAccumulator(0);
  for (const h of holders) acc.update(h.kp.publicKey.toBase58(), BigInt(h.whole) * 1_000_000n, 0);
  const snap = buildSnapshot(acc.finalize(3600), 6);
  check("snapshot total = 1000 tickets", snap.total === 1000n, `${snap.total}`);

  const wins: Record<string, number> = {};
  const DRAWS = 4, POT = 1000;
  for (let d = 0; d < DRAWS; d++) {
    await mintTo(conn, ops, prize, potCustody, ops, POT, [], undefined, RP); // hour's fees → stock → pot
    await commitEpoch(prog, ops, refs, snap);
    await sleep((EPOCH_LEN + 1) * 1000); // epoch elapses; production waits a random moment
    await settleDevnet(prog, ops, refs);
    const wt = await winningTicketOf(prog, refs);
    const expected = winnerOf(snap, wt).entry;
    const potBefore = await bal(conn, potCustody);
    const { winner, tickets } = await payWinner(prog, ops, refs, snap, wt, conn);
    const winnerAta = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(prize, winner, false, RP);
    const got = await bal(conn, winnerAta);
    check(`draw ${d + 1}: ticket ${wt} paid the in-range holder`, winner.equals(expected.owner) && got >= POT && (await bal(conn, potCustody)) === 0,
      `winner=${winner.toBase58().slice(0, 6)} tickets=${tickets} potBefore=${potBefore}`);
    wins[winner.toBase58()] = (wins[winner.toBase58()] || 0) + 1;
  }

  // odds check: over the draws, only holders with tickets ever win, weighted by holdings
  const winners = Object.keys(wins);
  check("only real holders won", winners.every((w) => holders.some((h) => h.kp.publicKey.toBase58() === w)));
  console.log("  win distribution:", holders.map((h) => `${h.whole}:${wins[h.kp.publicKey.toBase58()] || 0}`).join("  "));

  console.log("\n=== solum :: full hourly draw cycle ===");
  let pass = 0;
  for (const r of results) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  — " + r.detail}`); if (r.ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  if (pass !== results.length) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
