# Ballast — Audit Package

Prepared for external security review. Pairs with [`SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md)
(design + threat model) and the test suites under `tests/`. **Devnet only; not yet deployed to
mainnet.**

## Scope

- **In scope:** `programs/ballast` — the vault program. Program id
  `A8LrxCF86mcBzUZSFd55g6xD96T1xzmkHwPQTCQKcBcU`. Anchor 0.31.1, Solana SBF (rustc 1.79).
- **Out of scope:** `programs/mock-venue` is a TEST-ONLY constant-rate AMM used to exercise
  `add_backing`; it is never deployed to mainnet. The pump.fun program itself (the coin is a
  plain SPL token launched there; Ballast only reads/uses the mint).

## Core invariant (the one thing to break)

**No instruction moves a vault asset except:**
1. a holder redeeming their **own** pro-rata share (`redeem` — user-signed, burn-backed), or
2. a swap that **adds** backing into the vault (`add_backing` — bounded by an oracle net-effect guard).

There is **no** `withdraw`, `admin_withdraw`, `emergency_withdraw`, or `sweep`. The vault
authority is a PDA with no private key. Admin and engine authorities can configure and trigger
backing but can never extract value, even if fully compromised. Confirm by inspecting the IDL:
8 instructions, none of which remove value except `redeem`.

## Instructions

| ix | signer | effect | key guards |
|----|--------|--------|-----------|
| `initialize_vault` | admin | one-time config: stock allowlist, engine, venue, slippage cap | fee/slippage ≤ hard caps; no zero/dup stocks; PDAs derived |
| `deposit_stock` | anyone | add backing stock to the vault (buyback) | stock ∈ allowlist; dest is the vault ATA (owner == vault PDA, mint matches); only increases |
| `redeem` | holder | burn N coins → pro-rata slice of every vault stock | supply captured **before** burn; payout `= N·bal/supply` in u128 **rounded down**; source must be vault-owned; burns via coin's token program, pays via stock's token program |
| `add_backing` | engine | swap funding→stock via allowlisted venue into vault | venue == allowlisted; **reload** vault after CPI, require stock ↑ ≥ oracle floor·(1−slippage) and funding ↓ ≤ amount_in; oracle freshness ≤ 300 slots; **rejects any vault-owned account in venue accounts** |
| `harvest_fees` | anyone | pull Token-2022 withheld fees → vault fee account | dest vault-owned + correct mint; PDA-signed. **N/A to a pump.fun (classic-SPL) coin — alternative for a self-issued Token-2022 launch** |
| `set_price` | admin | publish a stock price to its PriceFeed PDA | price > 0, expo ≤ 0. **Devnet oracle stand-in — see limitations** |
| `set_pause` / `set_engine` | admin | pause; rotate engine | cannot move funds |

## Threat model → mitigation

- **Compromised engine key** → can only trigger `add_backing`, bounded by the net-effect guard
  (vault must gain ≥ oracle floor for ≤ amount_in spent). Cannot redeem, cannot withdraw.
- **Compromised admin key** → can pause, rotate engine, re-allowlist, set devnet prices — but
  **cannot move a single unit out of the vault.** No drain instruction exists.
- **Hostile `redeem` accounts** → source must be vault-owned (`BadVaultOwner`); stock must match
  allowlist index (`StockMismatch`); over-redeem rejected (`AmountExceedsSupply`).
- **Hostile / self-dealing swap venue** → net-effect guard reverts any fill below the oracle
  floor (`InsufficientBacking`); vault-owned accounts are rejected from the venue account set.
- **Rounding** → payout rounds down (redeemer never over-paid; floor preserved/rises); all value
  math is checked u128.

## Test coverage (all pass on a local validator)

| Suite | Cases | Proves |
|-------|-------|--------|
| `tests/standalone-redeem.ts` | 12 | deposit funds vault; deposit-to-non-vault rejected; dual-program redeem exact; hostile source / over-redeem / mismatch / zero / paused all revert; floor preserved |
| `tests/standalone-backing.ts` | 6 | honest fill lands ≥ floor & spends ≤ amount_in; shortchange / wrong-venue / non-engine / paused all revert |
| `tests/standalone-fees.ts` | 2 | withheld fees land only in the vault; harvest-to-attacker rejected |

## Assumptions & limitations (please review)

1. **Oracle (devnet):** `set_price` is an admin-published `PriceFeed`. It is a **stand-in for
   Pyth**; production must bind `add_backing` to a Pyth (or equivalent) feed. With the devnet
   oracle, `add_backing`'s floor is only as honest as the admin. **The primary funding path
   (`deposit_stock`) does not use the oracle at all** and is unaffected.
2. **`add_backing` venue trust:** the guard bounds the outcome for `funding_vault` and
   `stock_vault`, and vault-owned accounts are now rejected from the venue account set. The
   venue is still admin-allowlisted and should be a **reviewed adapter**; `deposit_stock` is the
   trust-minimal path and is recommended for the pump.fun manual-buyback model.
3. **Upgrade authority:** on mainnet the program must be non-upgradeable **or** its upgrade
   authority held by a timelocked multisig (e.g. Squads). User assets live in PDAs; no upgrade
   should silently add a drain path.
4. **Token program assumption:** the coin is classic SPL (pump.fun) and stocks are Token-2022;
   `redeem`/`deposit_stock` pass both programs explicitly. Mixed-program stock baskets are
   supported per-mint by the read layer but each stock in one vault is assumed Token-2022.
5. **Legal:** redemption of a token for tokenized securities is an open regulatory question and
   must be reviewed before mainnet.

## Build / verify
`anchor build` (pins in `Cargo.lock` for the 1.79 SBF toolchain). Tests: start
`solana-test-validator`, fund the wallet, `anchor deploy --provider.cluster localnet`, then run
the standalone suites (see [`TESTING.md`](TESTING.md)).
