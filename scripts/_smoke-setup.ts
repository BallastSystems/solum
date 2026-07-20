// Test helper: create a pump-style classic coin + a Token-2022 stock the operator holds,
// so the CLI smoke test has something to init/price/deposit/verify against.
import * as anchor from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, mintTo, createAssociatedTokenAccount } from "@solana/spl-token";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const coin = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
  const coinAta = await createAssociatedTokenAccount(conn, payer, coin, payer.publicKey, {}, TOKEN_PROGRAM_ID);
  await mintTo(conn, payer, coin, coinAta, payer, 1_000_000_000_000, [], undefined, TOKEN_PROGRAM_ID); // 1,000,000 supply

  const stock = await createMint(conn, payer, payer.publicKey, null, 6, undefined, undefined, TOKEN_2022_PROGRAM_ID);
  const stockAta = await createAssociatedTokenAccount(conn, payer, stock, payer.publicKey, {}, TOKEN_2022_PROGRAM_ID);
  await mintTo(conn, payer, stock, stockAta, payer, 1000_000000, [], undefined, TOKEN_2022_PROGRAM_ID); // 1000 shares

  console.log(`COIN=${coin.toBase58()}`);
  console.log(`STOCK=${stock.toBase58()}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
