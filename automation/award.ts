// Operator award CLI — you run this to MANUALLY send a claimed winner their tokenized-stock prize
// from the review wallet, within the 24h window that started when they claimed.
//
//   node target/build/award.js                # list winners who claimed and are awaiting delivery
//   node target/build/award.js <epoch>        # send that winner's prize
//   node target/build/award.js --all          # send every pending (claimed, unawarded) prize
//
// Env (same as the claim service): SOLUM_RPC, SOLUM_OPS_KEY (SECRET), SOLUM_STOCK_MINT,
// SOLUM_OPS_STOCK_ACCT, SOLUM_STOCK_PROGRAM, SOLUM_WINNERS_FILE.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { awardPrize, ClaimConfig } from "./claim";
import { WinnerEntry } from "./status";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WINDOW_MS = 24 * 3600 * 1000;

function loadKey(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}
const short = (a: string) => a.slice(0, 4) + "…" + a.slice(-4);
function leftOf(claimedAt: string | null): string {
  if (!claimedAt) return "—";
  const ms = Date.parse(claimedAt) + WINDOW_MS - Date.now();
  if (ms <= 0) return "OVERDUE";
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m left`;
}

async function main() {
  const cfg: ClaimConfig = {
    conn: new Connection(process.env.SOLUM_RPC || "http://127.0.0.1:8899", "confirmed"),
    ops: loadKey(need("SOLUM_OPS_KEY")),
    stockMint: new PublicKey(need("SOLUM_STOCK_MINT")),
    stockProgram: new PublicKey(process.env.SOLUM_STOCK_PROGRAM || TOKEN_2022),
    opsStockAccount: new PublicKey(need("SOLUM_OPS_STOCK_ACCT")),
    winnersFile: process.env.SOLUM_WINNERS_FILE || "automation/winners.json",
  };
  const arg = process.argv[2];
  const all: WinnerEntry[] = (() => {
    try { return JSON.parse(fs.readFileSync(cfg.winnersFile, "utf8")); } catch { return []; }
  })();
  const pending = all.filter((w) => w.claimed && !w.awarded);

  if (!arg) {
    console.log(`review wallet: ${cfg.ops.publicKey.toBase58()}\n`);
    if (!pending.length) return console.log("No winners are awaiting delivery.");
    console.log(`${pending.length} awaiting delivery:`);
    for (const w of pending)
      console.log(`  #${w.epoch}  ${short(w.addr)}  ${w.prizeShares} ${w.stock} (~$${w.prizeUsd})  claimed ${w.claimedAt}  ${leftOf(w.claimedAt)}`);
    console.log(`\nSend one:  node award.js <epoch>    ·    Send all:  node award.js --all`);
    return;
  }

  const targets = arg === "--all" ? pending.map((w) => w.epoch) : [Number(arg)];
  if (!targets.length) return console.log("Nothing to send.");
  for (const epoch of targets) {
    const r = await awardPrize(cfg, epoch);
    if (r.ok) console.log(`  #${epoch}  ✓ ${r.alreadyAwarded ? "already awarded" : "SENT"}  ${r.awardTx}`);
    else console.log(`  #${epoch}  ✗ ${(r as { reason: string }).reason}`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
