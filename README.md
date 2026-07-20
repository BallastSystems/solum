# Ballast

**The asset-backed launchpad.** A token launched on Ballast quietly accumulates real
tokenized stock into an on-chain vault with a slice of every trade — a **redeemable floor
that only rises.** Creators keep 100% of their fees. Memecoin culture, with a real balance
sheet.

- **No leverage, nothing to liquidate.** Backing is *spot the vault actually holds.*
- **Redeemable floor.** Holders can burn tokens for their pro-rata share of the vault, on-chain, anytime.
- **Verifiable.** The vault balances *are* the proof-of-reserves.
- **Safe by construction.** The engine can trigger backing; it can **never extract value.** See [`docs/SECURITY-ARCHITECTURE.md`](docs/SECURITY-ARCHITECTURE.md).

## Status
Pre-alpha. **Devnet only.** No mainnet, no real assets, until audited and legally reviewed.

## Layout
- `programs/` — Solana (Anchor) on-chain program: vault, backing, redemption.
- `engine/` — off-chain trigger for `add_backing` (holds **no** extraction power).
- `app/` — proof-of-reserves dashboard + launch UI.
- `docs/` — architecture + security.

## Toolchain
Anchor 0.31.1 · Solana 2.1.x · devnet.
