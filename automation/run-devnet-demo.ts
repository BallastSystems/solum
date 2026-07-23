// One full raffle on PUBLIC devnet, narrated with an explorer link for every step — the artifact
// to screen-record. Creates the $SOLUM coin + a stock, three holders, funds the pot from "fees",
// snapshots holders (weighted), draws a winner via randomness, and pays them — all on-chain.
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=<key> \
//     npx tsc automation/run-devnet-demo.ts --outDir target/autobuild --module commonjs \
//       --target es2020 --esModuleInterop --resolveJsonModule --skipLibCheck --moduleResolution node \
//     && node target/autobuild/run-devnet-demo.js

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, mintTo,
  createAssociatedTokenAccount, getAssociatedTokenAddressSync, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { buildSnapshot, winnerOf } from "./twab";
import { toArray } from "./merkle";

const CP = TOKEN_PROGRAM_ID, RP = TOKEN_2022_PROGRAM_ID, DEC = 6, SCALE = 10n ** 6n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer;
  const rpc = (conn as any)._rpcEndpoint as string;
  const isLocal = /127\.0\.0\.1|localhost/.test(rpc);
  if (!/devnet/.test(rpc) && !isLocal) throw new Error(`refusing to run the demo on mainnet: ${rpc}`);
  // Explorer links: devnet cluster, or the local validator via Explorer's custom-cluster mode
  // (works in a browser on the same machine — real, recordable transaction pages, no faucet needed).
  const cl = isLocal ? `custom&customUrl=${encodeURIComponent(rpc)}` : "devnet";
  const tx = (s: string) => `  → tx: https://explorer.solana.com/tx/${s}?cluster=${cl}`;
  const acct = (a: string) => `https://explorer.solana.com/address/${a}?cluster=${cl}`;
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);
  const bal = async (a: PublicKey) => Number((await getAccount(conn, a, undefined, RP)).amount);

  console.log(`\n=== SOLUM · live raffle · ${isLocal ? "local validator" : "devnet"} ===`);
  console.log(`(Explorer links use ${isLocal ? "custom-cluster mode → your local validator; keep it running to open them" : "the devnet cluster"})`);
  console.log(`program: ${acct(prog.programId.toBase58())}\n`);

  console.log("1) mint the $SOLUM coin + the AAPLx stock");
  const coin = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, CP);
  const stock = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, RP);
  console.log(`   $SOLUM: ${acct(coin.toBase58())}`);
  console.log(`   AAPLx:  ${acct(stock.toBase58())}`);

  console.log("\n2) create the jackpot (undrainable pot custody, PDA — no private key)");
  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), ops.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const pot = await createAssociatedTokenAccount(conn, ops, stock, jAuth, {}, RP, undefined, true);
  const initSig = await prog.methods.initJackpot(new anchor.BN(5)).accounts({
    admin: ops.publicKey, coinMint: coin, prizeMint: stock, snapshotter: ops.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody: pot, systemProgram: SystemProgram.programId,
  }).rpc();
  console.log(`   jackpot: ${acct(jackpot.toBase58())}`);
  console.log(tx(initSig));

  console.log("\n3) three holders buy $SOLUM (their average balance sets their odds)");
  const holders = await Promise.all([500, 300, 200].map(async (whole) => {
    const kp = Keypair.generate();
    const coinAta = await createAssociatedTokenAccount(conn, ops, coin, kp.publicKey, {}, CP);
    await mintTo(conn, ops, coin, coinAta, ops, whole * 1e6, [], undefined, CP);
    const stockAta = await createAssociatedTokenAccount(conn, ops, stock, kp.publicKey, {}, RP);
    console.log(`   holder ${kp.publicKey.toBase58().slice(0, 8)}… holds ${whole} $SOLUM`);
    return { kp, whole, stockAta };
  }));

  console.log("\n4) an hour of creator fees buys real stock into the pot");
  const POT = 1000;
  const fundSig = await mintTo(conn, ops, stock, pot, ops, POT, [], undefined, RP);
  console.log(`   +${POT} AAPLx into the pot`);
  console.log(tx(fundSig));

  console.log("\n5) snapshot all holders (weighted by holdings) and commit the Merkle root");
  const twab = new Map<string, bigint>();
  for (const h of holders) twab.set(h.kp.publicKey.toBase58(), BigInt(h.whole) * SCALE);
  const snap = buildSnapshot(twab, DEC);
  const commitSig = await prog.methods.commitEpoch(toArray(snap.root), new anchor.BN(snap.total.toString()))
    .accounts({ snapshotter: ops.publicKey, jackpot }).rpc();
  console.log(`   ${snap.entries.length} holders · ${snap.total} tickets · root ${snap.root.toString("hex").slice(0, 16)}…`);
  console.log(tx(commitSig));

  console.log("\n6) draw the winner from randomness (devnet build; production = Switchboard VRF)");
  await sleep(6000); // let the epoch elapse
  const settleSig = await prog.methods.settleDraw(toArray(randomBytes(32)))
    .accounts({ snapshotter: ops.publicKey, jackpot }).rpc();
  const wt = BigInt((await (prog.account as any).jackpotState.fetch(jackpot)).winningTicket.toString());
  const { entry, proof } = winnerOf(snap, wt);
  console.log(`   winning ticket ${wt} → holder ${entry.owner.toBase58().slice(0, 8)}…`);
  console.log(tx(settleSig));

  console.log("\n7) pay the winner the whole pot (funds can only reach the drawn holder)");
  const before = await bal(getAssociatedTokenAddressSync(stock, entry.owner, false, RP));
  const claimSig = await prog.methods.claimPrize(new anchor.BN(entry.start.toString()), new anchor.BN(entry.tickets.toString()), proof.map(toArray))
    .accounts({
      caller: ops.publicKey, winner: entry.owner, jackpot, jackpotAuthority: jAuth, prizeMint: stock,
      potCustody: pot, winnerPrizeAccount: getAssociatedTokenAddressSync(stock, entry.owner, false, RP), prizeTokenProgram: RP,
    }).rpc();
  const after = await bal(getAssociatedTokenAddressSync(stock, entry.owner, false, RP));
  console.log(`   winner received ${after - before} AAPLx · pot now ${await bal(pot)}`);
  console.log(tx(claimSig));

  console.log(`\n✅ done — a full raffle on devnet. Winner: ${entry.owner.toBase58()}`);
  console.log(`   winner account: ${acct(entry.owner.toBase58())}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
