// PHASE A — mainnet Switchboard VRF smoke test (throwaway test jackpot, NO $SOLUM, NO real prize).
// Proves the ONE thing that can only be proven live: request_draw + settle_draw against the real
// mainnet Switchboard On-Demand oracle actually produce a winning ticket from verifiable randomness.
//
// It creates disposable coin/prize mints, inits a short-epoch jackpot, commits a 3-holder snapshot,
// then fires the production VRF path (createAndCommit + request_draw in one slot → oracle reveal →
// settle_draw) and checks the winning ticket maps to a real holder. Uses the PRODUCTION IDL.
//
//   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com ANCHOR_WALLET=.wallet/solum-ops.json \
//     npx tsc automation/mainnet-vrf-smoke.ts --outDir target/autobuild --module commonjs \
//       --target es2020 --esModuleInterop --resolveJsonModule --skipLibCheck --moduleResolution node \
//     && node target/autobuild/automation/mainnet-vrf-smoke.js

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, createAssociatedTokenAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { buildSnapshot, winnerOf } from "./twab";
import { commitEpoch, requestDrawVrf, settleDrawVrf, winningTicketOf, loadSwitchboardQueue, JackpotRefs } from "./draw";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer;
  const rpc = (conn as any)._rpcEndpoint as string;
  if (!/mainnet/.test(rpc)) throw new Error(`this smoke test is mainnet-only; got ${rpc}`);

  // PRODUCTION IDL (settle_draw takes no arg + request_draw present)
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum-prod.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);
  const CP = TOKEN_PROGRAM_ID, RP = TOKEN_2022_PROGRAM_ID, DEC = 6;
  console.log(`cluster : ${rpc}`);
  console.log(`ops     : ${ops.publicKey.toBase58()}`);
  console.log(`program : ${prog.programId.toBase58()}\n`);

  // disposable coin + prize mints (NOT $SOLUM, NOT a real stock)
  console.log("• creating throwaway coin + prize mints…");
  const coin = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, CP);
  const prize = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, RP);

  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), ops.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const pot = await createAssociatedTokenAccount(conn, ops, prize, jAuth, {}, RP, undefined, true);

  console.log("• init_jackpot (epoch_len = 1s)…");
  await prog.methods.initJackpot(new anchor.BN(1)).accounts({
    admin: ops.publicKey, coinMint: coin, prizeMint: prize, snapshotter: ops.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody: pot, systemProgram: SystemProgram.programId,
  }).rpc();

  const refs: JackpotRefs = { jackpot, jackpotAuthority: jAuth, prizeMint: prize, potCustody: pot, prizeTokenProgram: RP };

  // 3 holders (500 / 300 / 200 whole tokens → 1000 tickets)
  const holders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const twab = new Map<string, bigint>([
    [holders[0].publicKey.toBase58(), 500n * 10n ** BigInt(DEC)],
    [holders[1].publicKey.toBase58(), 300n * 10n ** BigInt(DEC)],
    [holders[2].publicKey.toBase58(), 200n * 10n ** BigInt(DEC)],
  ]);
  const snap = buildSnapshot(twab, DEC);
  console.log(`• commit_epoch (${snap.total} tickets across ${snap.entries.length} holders)…`);
  await commitEpoch(prog, ops, refs, snap);

  console.log("• waiting for the epoch to elapse…");
  await sleep(3000);

  console.log("• loading mainnet Switchboard On-Demand queue…");
  const queue = await loadSwitchboardQueue(conn);
  console.log(`  queue: ${queue.pubkey.toBase58()}`);

  console.log("• request_draw (createAndCommit + request in one slot)…");
  const rnd = await requestDrawVrf(prog, queue, ops, refs, conn);
  console.log(`  randomness account: ${rnd.pubkey.toBase58()}`);

  console.log("• settle_draw (reveal oracle value → fix winning ticket; retries until revealed)…");
  await settleDrawVrf(prog, rnd, ops, refs, conn);

  const ticket = await winningTicketOf(prog, refs);
  const { entry } = winnerOf(snap, ticket);
  const inRange = ticket >= entry.start && ticket < entry.start + entry.tickets;

  console.log("\n=== RESULT ===");
  console.log(`winning ticket : ${ticket} / ${snap.total}`);
  console.log(`winner         : ${entry.owner.toBase58()}`);
  console.log(`ticket in range: ${inRange}`);
  const ok = inRange && ticket < snap.total;
  console.log(ok
    ? "\n✅ LIVE SWITCHBOARD VRF PROVEN ON MAINNET — real oracle randomness produced a valid winner."
    : "\n❌ VRF result invalid — do NOT launch.");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("SMOKE TEST FAILED:", e); process.exit(1); });
