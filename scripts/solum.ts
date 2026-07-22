// Solum operator CLI. Wallet + RPC come from the environment:
//   ANCHOR_PROVIDER_URL=<rpc>  ANCHOR_WALLET=<keypair.json>
//
//   solum init-vault  <coinMint> <stockMint[,stockMint...]> [--slippage bps] [--venue PUBKEY] [--engine PUBKEY]
//   solum set-price   <coinMint> <stockMint> <priceWholeQuote> [expo=0]
//   solum deposit     <coinMint> <stockMint> <sharesWhole>        # a buyback: adds backing
//   solum reserves    <coinMint>
//
// deposit/init only ever ADD to or configure the vault; nothing here can remove value.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getAccount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { computeReserves } from "../app/reserves";

const args = process.argv.slice(2);
const cmd = args[0];
const pos = args.slice(1).filter((a) => !a.startsWith("--"));
const opt = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

function ctx() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, provider);
  return { provider, conn: provider.connection, wallet: (provider.wallet as anchor.Wallet).payer, program };
}
// A vault is uniquely (coin, admin). The operator's own commands use their wallet as admin.
const pdas = (program: anchor.Program, coin: PublicKey, admin: PublicKey) => ({
  config: PublicKey.findProgramAddressSync([Buffer.from("config"), coin.toBuffer(), admin.toBuffer()], program.programId)[0],
  vault: PublicKey.findProgramAddressSync([Buffer.from("vault"), coin.toBuffer(), admin.toBuffer()], program.programId)[0],
});
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
async function tokenProgramOf(conn: anchor.web3.Connection, mint: PublicKey) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`mint not found: ${mint.toBase58()}`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}
async function ensureAta(conn: anchor.web3.Connection, wallet: any, sendTx: (t: Transaction) => Promise<string>,
                        mint: PublicKey, owner: PublicKey, program: PublicKey, allowOffCurve: boolean) {
  const ata = getAssociatedTokenAddressSync(mint, owner, allowOffCurve, program);
  const info = await conn.getAccountInfo(ata);
  if (!info) {
    await sendTx(new Transaction().add(
      createAssociatedTokenAccountInstruction(wallet.publicKey, ata, owner, mint, program)));
    console.log(`  created token account ${ata.toBase58()}`);
  }
  return ata;
}

async function main() {
  const { provider, conn, wallet, program } = ctx();
  const send = (t: Transaction) => provider.sendAndConfirm(t, []);

  if (cmd === "init-vault") {
    const coin = new PublicKey(pos[0]);
    const stocks = pos[1].split(",").map((s) => new PublicKey(s));
    const slippage = parseInt(opt("slippage", "300")!);
    const venue = new PublicKey(opt("venue", wallet.publicKey.toBase58())!);
    const engine = new PublicKey(opt("engine", wallet.publicKey.toBase58())!);
    const funding = new PublicKey(opt("funding", WSOL.toBase58())!);
    const sig = await program.methods
      .initializeVault(0, slippage, engine, venue, funding, stocks)
      .accounts({ admin: wallet.publicKey, tokenMint: coin })
      .rpc();
    console.log(`vault created for ${coin.toBase58()}\n  stocks: ${stocks.map((s) => s.toBase58()).join(", ")}\n  ${sig}`);
    return;
  }

  if (cmd === "set-price") {
    const coin = new PublicKey(pos[0]), stock = new PublicKey(pos[1]);
    const price = parseInt(pos[2]), expo = parseInt(pos[3] ?? "0");
    const sig = await program.methods.setPrice(new anchor.BN(price), expo)
      .accounts({ config: pdas(program, coin, wallet.publicKey).config, admin: wallet.publicKey, stockMint: stock })
      .rpc();
    console.log(`price set: 1 ${stock.toBase58().slice(0, 6)}… = ${price}e${expo} quote\n  ${sig}`);
    return;
  }

  if (cmd === "deposit") {
    const coin = new PublicKey(pos[0]), stock = new PublicKey(pos[1]);
    const { config, vault } = pdas(program, coin, wallet.publicKey);
    const sp = await tokenProgramOf(conn, stock);
    const decimals = (await getMint(conn, stock, undefined, sp)).decimals;
    const amount = BigInt(Math.round(parseFloat(pos[2]) * 10 ** decimals));

    const src = getAssociatedTokenAddressSync(stock, wallet.publicKey, false, sp);
    const srcInfo = await conn.getAccountInfo(src);
    if (!srcInfo) throw new Error(`you hold no ${stock.toBase58().slice(0, 6)}… — buy the stock first (its ATA ${src.toBase58()} does not exist)`);
    const have = (await getAccount(conn, src, undefined, sp)).amount;
    if (have < amount) throw new Error(`insufficient balance: have ${have}, need ${amount}`);

    const vaultAta = await ensureAta(conn, wallet, send, stock, vault, sp, true);
    const sig = await program.methods.depositStock(new anchor.BN(amount.toString()))
      .accounts({ config, vaultAuthority: vault, stockMint: stock, depositor: wallet.publicKey,
        depositorStockAccount: src, stockVault: vaultAta, stockTokenProgram: sp })
      .rpc();
    console.log(`buyback deposited: ${pos[2]} shares → vault\n  ${sig}`);
    return;
  }

  if (cmd === "reserves") {
    const coin = new PublicKey(pos[0]);
    const admin = new PublicKey(opt("admin", wallet.publicKey.toBase58())!);
    const r = await computeReserves(conn, program, coin, admin);
    console.log(`\nProof of Reserves — ${coin.toBase58()}`);
    console.log(`  supply           ${r.supplyWhole.toLocaleString()}`);
    for (const s of r.stocks) console.log(`  ${s.mint.slice(0, 8)}…  ${s.balanceWhole} @ $${s.price ?? "—"}  = $${s.valueQuote.toLocaleString()}`);
    console.log(`  total reserves   $${r.totalValueQuote.toLocaleString()}`);
    console.log(`  floor / token    $${r.floorPerTokenQuote}`);
    return;
  }

  console.error("commands: init-vault | set-price | deposit | reserves");
  process.exit(1);
}

main().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
