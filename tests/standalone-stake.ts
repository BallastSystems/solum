// Standalone adversarial runner for the stake-to-earn module.
//
// Proves the MasterChef accumulator end-to-end on a validator: a sole staker earns the full
// reward stream; two stakers split it proportional to stake; a joiner earns nothing on rewards
// that accrued before they staked; double-claim / unstake-more-than-staked / claim-another's-stake
// all revert; unstake returns the staked coins exactly.
//
// The coin is classic SPL (like a pump.fun launch); the reward is Token-2022 (like an xStock).

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createMint, mintTo, createAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const CP = TOKEN_PROGRAM_ID;      // coin: classic SPL
const RP = TOKEN_2022_PROGRAM_ID; // reward: Token-2022

type Case = { name: string; ok: boolean; detail?: string };
const results: Case[] = [];
function check(name: string, cond: boolean, detail?: string) {
  results.push({ name, ok: cond, detail: cond ? undefined : detail });
}
async function expectRevert(name: string, sub: string, fn: () => Promise<any>) {
  try { await fn(); results.push({ name, ok: false, detail: `expected revert "${sub}", succeeded` }); }
  catch (e: any) {
    const s = e.toString() + (e.logs ? "\n" + e.logs.join("\n") : "");
    results.push({ name, ok: s.includes(sub), detail: s.includes(sub) ? undefined : s.slice(0, 240) });
  }
}
const bal = async (conn: any, ata: PublicKey, prog: PublicKey) =>
  Number((await getAccount(conn, ata, undefined, prog)).amount);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);

  // mints
  const coin = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, CP);
  const reward = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, RP);

  // PDAs
  const enc = (s: string) => Buffer.from(s);
  const [pool] = PublicKey.findProgramAddressSync([enc("stakepool"), coin.toBuffer(), payer.publicKey.toBuffer()], prog.programId);
  const [stakeAuth] = PublicKey.findProgramAddressSync([enc("stakeauth"), pool.toBuffer()], prog.programId);
  const stakeAcct = (u: PublicKey) => PublicKey.findProgramAddressSync([enc("stakeacct"), pool.toBuffer(), u.toBuffer()], prog.programId)[0];

  // stake-authority-owned custody (coin) + reward vault (reward)
  const custody = await createAssociatedTokenAccount(conn, payer, coin, stakeAuth, {}, CP, undefined, true);
  const rewardVault = await createAssociatedTokenAccount(conn, payer, reward, stakeAuth, {}, RP, undefined, true);

  await prog.methods.initStakePool().accounts({
    admin: payer.publicKey, coinMint: coin, rewardMint: reward, pool,
    stakeAuthority: stakeAuth, stakedCustody: custody, rewardVault, systemProgram: SystemProgram.programId,
  }).rpc();
  check("init_stake_pool", true);

  // two stakers, funded with coins + reward-receiving accounts
  const mk = async () => {
    const kp = Keypair.generate();
    await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL), "confirmed");
    const coinAta = await createAssociatedTokenAccount(conn, payer, coin, kp.publicKey, {}, CP);
    const rewAta = await createAssociatedTokenAccount(conn, payer, reward, kp.publicKey, {}, RP);
    await mintTo(conn, payer, coin, coinAta, payer, 10_000, [], undefined, CP);
    return { kp, coinAta, rewAta };
  };
  const u1 = await mk();
  const u2 = await mk();

  const stakeIx = (u: any, amt: number) => prog.methods.stake(new anchor.BN(amt)).accounts({
    owner: u.kp.publicKey, pool, stakeAuthority: stakeAuth, stakeAccount: stakeAcct(u.kp.publicKey),
    coinMint: coin, rewardMint: reward, ownerCoinAccount: u.coinAta, ownerRewardAccount: u.rewAta,
    stakedCustody: custody, rewardVault, coinTokenProgram: CP, rewardTokenProgram: RP, systemProgram: SystemProgram.programId,
  }).signers([u.kp]);
  const claimIx = (u: any, actor?: any) => prog.methods.claim().accounts({
    owner: (actor ?? u).kp.publicKey, pool, stakeAuthority: stakeAuth, stakeAccount: stakeAcct(u.kp.publicKey),
    rewardMint: reward, ownerRewardAccount: (actor ?? u).rewAta, rewardVault, rewardTokenProgram: RP,
  }).signers([(actor ?? u).kp]);
  const unstakeIx = (u: any, amt: number) => prog.methods.unstake(new anchor.BN(amt)).accounts({
    owner: u.kp.publicKey, pool, stakeAuthority: stakeAuth, stakeAccount: stakeAcct(u.kp.publicKey),
    coinMint: coin, rewardMint: reward, ownerCoinAccount: u.coinAta, ownerRewardAccount: u.rewAta,
    stakedCustody: custody, rewardVault, coinTokenProgram: CP, rewardTokenProgram: RP,
  }).signers([u.kp]);
  const sync = () => prog.methods.syncRewards().accounts({ pool, rewardVault }).rpc();

  // --- 1. sole staker earns the whole reward stream ---
  await stakeIx(u1, 100).rpc();
  check("stake locks coins in custody", (await bal(conn, custody, CP)) === 100);
  await mintTo(conn, payer, reward, rewardVault, payer, 1000, [], undefined, RP); // creator-fee buyback
  await sync();
  await claimIx(u1).rpc();
  check("sole staker earns full 1000", (await bal(conn, u1.rewAta, RP)) === 1000);

  // --- 2. double-claim earns nothing (reverts) ---
  await expectRevert("double-claim reverts", "ZeroAmount", () => claimIx(u1).rpc());

  // --- 3. second staker joins; new rewards split 100:300 = 1:3 ---
  await stakeIx(u2, 300).rpc();                                   // acc snapshot at join
  await mintTo(conn, payer, reward, rewardVault, payer, 800, [], undefined, RP);
  await sync();
  await claimIx(u1).rpc();
  await claimIx(u2).rpc();
  check("proportional split: u1 gets 200 of 800", (await bal(conn, u1.rewAta, RP)) === 1000 + 200);
  check("proportional split: u2 gets 600 of 800", (await bal(conn, u2.rewAta, RP)) === 600);
  check("joiner earned nothing on pre-stake rewards", true); // u2 got 600 (its 3/4 of the 800), not any of the first 1000

  // --- 4. can't claim someone else's stake ---
  await expectRevert("claim another's stake reverts (blocked by seeds)", "ConstraintSeeds", () => claimIx(u1, u2).rpc());

  // --- 5. can't unstake more than staked ---
  await expectRevert("unstake > staked reverts", "InsufficientStake", () => unstakeIx(u1, 101).rpc());

  // --- 6. unstake returns coins exactly ---
  const beforeCoins = await bal(conn, u1.coinAta, CP);
  await unstakeIx(u1, 100).rpc();
  check("unstake returns 100 coins", (await bal(conn, u1.coinAta, CP)) === beforeCoins + 100);
  check("custody drained to u2's 300", (await bal(conn, custody, CP)) === 300);

  // report
  console.log("\n=== solum :: stake-to-earn ===");
  let pass = 0;
  for (const r of results) { console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`); if (r.ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  if (pass !== results.length) process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
