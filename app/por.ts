// Proof-of-reserves CLI: `por <coin-mint>` prints the vault's reserves and redeemable floor,
// read straight from the chain. Read-only — anyone can run it to verify a coin's backing.
//   ANCHOR_PROVIDER_URL=<rpc> npx ts-node app/por.ts <coin-mint>

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { computeReserves } from "./reserves";

async function main() {
  const mintArg = process.argv[2];
  const adminArg = process.argv[3];
  if (!mintArg || !adminArg) { console.error("usage: por <coin-mint> <vault-creator-pubkey>"); process.exit(1); }
  const url = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
  const conn = new Connection(url, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), {});
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, provider);

  const r = await computeReserves(conn, program, new PublicKey(mintArg), new PublicKey(adminArg));
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
