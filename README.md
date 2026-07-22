# Solum

**Give your memecoin a floor.** Keep **100% of your creator fees** — Solum bolts a
non-custodial vault of real tokenized stock (AAPLx, TSLAx, NVDAx…) onto your coin, one every
holder can redeem against, on-chain, anytime. Backing only goes up. The floor only rises.

Solum is a backing layer, not a launchpad: launch your coin wherever you like, then give it a
floor.

- **You keep 100% of your creator fees.** Solum never touches them.
- **A redeemable floor.** Holders burn their coins for a pro-rata share of the vault's real stock.
- **Backed by buybacks, with proof.** You (or anyone) deposit stock into the vault; every
  deposit is on-chain and verifiable. The vault balances *are* the proof-of-reserves.
- **Safe by construction.** The only way value ever leaves the vault is a holder redeeming
  their own burned share. No admin withdrawal, no drain path — see [`docs/SECURITY-ARCHITECTURE.md`](docs/SECURITY-ARCHITECTURE.md).

## How it works
1. Launch a normal coin (a standard SPL memecoin). Keep all your creator fees.
2. Open a Solum vault for the coin, allowlisting which stocks may back it.
3. Fund the vault with buybacks — `deposit_stock` (or `add_backing` to swap SOL→stock with an
   oracle price floor). Every deposit raises the redeemable floor and is publicly verifiable.
4. Holders `redeem`: burn coins, receive their exact pro-rata slice of the vault's stock.

## Status
Pre-alpha. **Devnet only.** No mainnet, no real assets, until audited and legally reviewed.

## Layout
- `programs/ballast/` — the vault program: `initialize_vault`, `deposit_stock`, `redeem`,
  `add_backing` (optional SOL→stock buyback with oracle floor), `set_price`, admin controls.
- `programs/mock-venue/` — TEST-ONLY swap venue for exercising `add_backing`.
- `app/` — proof-of-reserves read layer (`reserves.ts`).
- `docs/` — architecture, security, testing.

## Toolchain
Anchor 0.31.1 · Solana 2.1.x · devnet.
