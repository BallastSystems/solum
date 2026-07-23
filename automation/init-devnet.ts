// Initialize Solum on a live cluster (devnet): create the $SOLUM coin (a devnet stand-in — on
// mainnet this is the pump.fun mint), the five tokenized-stock mints, and the jackpot + pot custody.
// Writes automation/devnet-addresses.json for the draw bot. Uses the provider's cluster + wallet:
//
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=.wallet/your-devnet.json \
//     npx tsc automation/init-devnet.ts --outDir target/autobuild --module commonjs --target es2020 \
//       --esModuleInterop --resolveJsonModule --skipLibCheck --moduleResolution node \
//     && node target/autobuild/init-devnet.js

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, createAssociatedTokenAccount,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const STOCKS = ["AAPLx", "NVDAx", "TSLAx", "COINx", "MSTRx"];

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer;
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);
  const rpc = (conn as any)._rpcEndpoint as string;
  if (!/devnet|localhost|127\.0\.0\.1/.test(rpc)) throw new Error(`refusing to init on a non-devnet RPC: ${rpc}`);
  console.log(`cluster: ${rpc}\nadmin:   ${ops.publicKey.toBase58()}`);

  // $SOLUM coin (classic SPL, 6 dec) — devnet stand-in for the pump.fun mint
  const coin = await createMint(conn, ops, ops.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  console.log(`coin ($SOLUM): ${coin.toBase58()}`);

  // five tokenized-stock mints (Token-2022, 6 dec) — devnet stand-ins for the Sunrise xStocks
  const stocks: Record<string, string> = {};
  for (const s of STOCKS) {
    const m = await createMint(conn, ops, ops.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
    stocks[s] = m.toBase58();
    console.log(`  ${s}: ${m.toBase58()}`);
  }
  // The jackpot binds ONE prize mint. True 5-stock hourly rotation needs a small `set_prize_mint`
  // enhancement (swap the prize mint + pot between OPEN epochs) — see docs/DEVNET.md. For now the
  // jackpot is initialized with AAPLx; the bot funds/draws that stock.
  const prize = new PublicKey(stocks["AAPLx"]);

  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), ops.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const pot = await createAssociatedTokenAccount(conn, ops, prize, jAuth, {}, TOKEN_2022_PROGRAM_ID, undefined, true);
  await prog.methods.initJackpot(new anchor.BN(3600)).accounts({
    admin: ops.publicKey, coinMint: coin, prizeMint: prize, snapshotter: ops.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody: pot, systemProgram: SystemProgram.programId,
  }).rpc();

  const out = {
    cluster: rpc, programId: prog.programId.toBase58(), admin: ops.publicKey.toBase58(),
    coinMint: coin.toBase58(), stocks, jackpot: jackpot.toBase58(),
    jackpotAuthority: jAuth.toBase58(), potCustody: pot.toBase58(), prizeMint: prize.toBase58(), epochLenSec: 3600,
  };
  fs.writeFileSync("automation/devnet-addresses.json", JSON.stringify(out, null, 2));
  console.log(`\n✅ jackpot initialized · addresses written to automation/devnet-addresses.json`);
  console.log(`   jackpot:  https://explorer.solana.com/address/${jackpot.toBase58()}?cluster=devnet`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
