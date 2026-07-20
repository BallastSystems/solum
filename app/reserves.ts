// Proof-of-reserves — read-only. The vault's on-chain balances ARE the reserves; this reads
// them directly and derives the per-token floor. No custody, no off-chain trust: anyone can
// recompute this from the chain. Values are in the funding ("quote") asset's whole units.

import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";

export interface StockReserve {
  mint: string;
  balanceBase: string;
  balanceWhole: number;
  price: number | null; // whole quote per whole stock (null if no live feed)
  expo: number | null;
  publishSlot: number | null;
  valueQuote: number; // whole quote units backing this stock
}

export interface Reserves {
  tokenMint: string;
  vaultAuthority: string;
  supplyBase: string;
  supplyWhole: number;
  decimals: number;
  stocks: StockReserve[];
  totalValueQuote: number;
  floorPerTokenQuote: number; // the redeemable floor: total reserves / circulating supply
  asOfSlot: number;
}

export async function computeReserves(
  connection: Connection,
  program: anchor.Program,
  tokenMint: PublicKey,
  tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID
): Promise<Reserves> {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), tokenMint.toBuffer()], program.programId);
  const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from("vault"), tokenMint.toBuffer()], program.programId);
  const cfg: any = await (program.account as any).vaultConfig.fetch(configPda);

  const mintInfo = await getMint(connection, tokenMint, undefined, tokenProgram);
  const decimals = mintInfo.decimals;
  const supplyBase = mintInfo.supply;
  const supplyWhole = Number(supplyBase) / 10 ** decimals;

  const stockCount = cfg.stockCount as number;
  const stocks: StockReserve[] = [];
  let total = 0;

  for (let i = 0; i < stockCount; i++) {
    const stockMint = cfg.stockAllowlist[i] as PublicKey;
    const sm = await getMint(connection, stockMint, undefined, tokenProgram);
    const ata = getAssociatedTokenAddressSync(stockMint, vaultAuth, true, tokenProgram);

    let balBase = 0n;
    try { balBase = (await getAccount(connection, ata, undefined, tokenProgram)).amount; } catch { /* uncreated -> 0 */ }
    const balanceWhole = Number(balBase) / 10 ** sm.decimals;

    let price: number | null = null, expo: number | null = null, publishSlot: number | null = null;
    try {
      const [pf] = PublicKey.findProgramAddressSync([Buffer.from("price"), stockMint.toBuffer()], program.programId);
      const feed: any = await (program.account as any).priceFeed.fetch(pf);
      expo = feed.expo;
      price = Number(feed.price) * 10 ** feed.expo;
      publishSlot = Number(feed.publishSlot);
    } catch { /* no live feed -> value 0, surfaced as null price */ }

    const valueQuote = price !== null ? balanceWhole * price : 0;
    total += valueQuote;
    stocks.push({ mint: stockMint.toBase58(), balanceBase: balBase.toString(), balanceWhole, price, expo, publishSlot, valueQuote });
  }

  const asOfSlot = await connection.getSlot();
  return {
    tokenMint: tokenMint.toBase58(),
    vaultAuthority: vaultAuth.toBase58(),
    supplyBase: supplyBase.toString(),
    supplyWhole,
    decimals,
    stocks,
    totalValueQuote: total,
    floorPerTokenQuote: supplyWhole > 0 ? total / supplyWhole : 0,
    asOfSlot,
  };
}
