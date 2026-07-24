// PHASE A — prove the "buy the prize" leg live on mainnet: pick ONE of the five verified xStocks at
// RANDOM (exactly as the snapshot does), buy a tiny amount of SOL worth through the PRODUCTION
// buyStock() path, and report the EXACT shares received (measured from the on-chain balance delta,
// not the quote). The bought stock stays in the ops (DWtw) wallet for the operator's manual delivery.
//
//   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com ANCHOR_WALLET=.wallet/solum-ops.json \
//     npx tsc automation/mainnet-buy-proof.ts --outDir target/autobuild ... && node target/autobuild/mainnet-buy-proof.js

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { buyStock } from "./fees";

const STOCKS: Record<string, string> = {
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  TSLAx: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
  COINx: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
  MSTRx: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
};
const SOL_TO_SPEND = 0.03;

async function main() {
  const provider = anchor.AnchorProvider.env();
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer;
  if (!/mainnet/.test((conn as any)._rpcEndpoint)) throw new Error("mainnet only");

  // random stock, exactly like the snapshot's prize selection
  const labels = Object.keys(STOCKS);
  const label = labels[Math.floor(Math.random() * labels.length)];
  const mint = new PublicKey(STOCKS[label]);
  const opsAta = getAssociatedTokenAddressSync(mint, ops.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const dec = (await getMint(conn, mint, undefined, TOKEN_2022_PROGRAM_ID)).decimals;

  console.log(`ops wallet : ${ops.publicKey.toBase58()}`);
  console.log(`random pick: ${label}  (${mint.toBase58()})`);
  console.log(`spending   : ${SOL_TO_SPEND} SOL  →  buying via production buyStock()\n`);

  const received = await buyStock(conn, ops, Math.round(SOL_TO_SPEND * 1e9), mint.toBase58(), opsAta);
  const shares = Number(received) / 10 ** dec;

  // cross-check: read the ACTUAL on-chain balance now sitting in the ops wallet
  const bal = await conn.getTokenAccountBalance(opsAta, "confirmed");
  console.log("=== RESULT ===");
  console.log(`prize stock    : ${label}`);
  console.log(`shares received: ${shares}  (${received} base units, ${dec} decimals)`);
  console.log(`ops wallet now holds: ${bal.value.uiAmountString} ${label}  (on-chain, ready for manual delivery)`);
  const ok = received > 0n && bal.value.amount === received.toString();
  console.log(ok
    ? `\n✅ BUY LEG PROVEN ON MAINNET — random ${label} bought, exact shares measured from the real balance.`
    : `\n⚠️ balance/received mismatch — investigate (received=${received}, onchain=${bal.value.amount})`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("BUY PROOF FAILED:", e); process.exit(1); });
