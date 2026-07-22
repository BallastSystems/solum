# Solum — Audit Package

Prepared for external security review. Pairs with [`SECURITY-ARCHITECTURE.md`](SECURITY-ARCHITECTURE.md)
(design + threat model) and the test suites under `tests/`. **Devnet only; not yet deployed to
mainnet.**

## Scope

- **In scope:** `programs/ballast` — the vault program. Program id
  `A8LrxCF86mcBzUZSFd55g6xD96T1xzmkHwPQTCQKcBcU`. Anchor 0.31.1, Solana SBF (rustc 1.79).
- **Out of scope:** `programs/mock-venue` is a TEST-ONLY constant-rate AMM used to exercise
  `add_backing`; it is never deployed to mainnet. The pump.fun program itself (the coin is a
  plain SPL token launched there; Solum only reads/uses the mint).

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
| `initialize_vault` | admin | one-time config: stock allowlist, engine, venue, funding mint, slippage cap | fee/slippage ≤ hard caps; no zero/dup stocks; funding mint ≠ any stock; **config + vault PDAs bound to (token_mint, admin) — no front-run hijack** |
| `deposit_stock` | anyone | add backing stock to the vault (buyback) | stock ∈ allowlist; dest is the vault ATA (owner == vault PDA, mint matches); only increases |
| `redeem` | holder | burn N coins → pro-rata slice of every vault stock | supply captured **before** burn; payout `= N·bal/supply` in u128 **rounded down**; source must be vault-owned; burns via coin's token program, pays via stock's token program |
| `add_backing` | engine | swap funding→stock via allowlisted venue into vault | venue == allowlisted; **funding mint pinned to `config.funding_mint` (never a stock)**; **reload** vault after CPI, require stock ↑ ≥ oracle floor·(1−slippage) and funding ↓ ≤ amount_in; oracle freshness ≤ 300 slots; rejects any vault-owned account in venue accounts |
| `harvest_fees` | anyone | pull Token-2022 withheld fees → vault fee account | dest vault-owned + correct mint; PDA-signed. **N/A to a pump.fun (classic-SPL) coin — alternative for a self-issued Token-2022 launch** |
| `set_price` | admin | publish a stock price to the vault's per-stock PriceFeed PDA | price > 0, expo ≤ 0; **stock ∈ this vault's allowlist; feed is per-vault (seeded by config) — no cross-vault oracle pollution**. Devnet oracle stand-in — see limitations |
| `set_pause` / `set_engine` | admin | pause add_backing; rotate engine | cannot move funds; **does NOT block `redeem` — the floor is always redeemable** |

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
| `tests/standalone-redeem.ts` | 12 | deposit funds vault; deposit-to-non-vault rejected; dual-program redeem exact; hostile source / over-redeem / mismatch / zero revert; **redeem succeeds while paused**; floor preserved |
| `tests/standalone-backing.ts` | 7 | honest fill lands ≥ floor & spends ≤ amount_in; shortchange / wrong-venue / non-engine / paused / **venue-delegate-tampering** all revert |
| `tests/standalone-fees.ts` | 2 | withheld fees land only in the vault; harvest-to-attacker rejected |
| `tests/standalone-hardening.ts` | 4 | front-run vault is a separate account & non-admin can't control it; funding ≠ stock; set_price is allowlist-scoped |
| `tests/fuzz-invariants.ts` | 1,200+/run | stateful property-based fuzzer vs an off-chain reference model — invariants I1–I4 (below) |
| Rust unit tests (`#[cfg(test)] mod tests`) | 14 | the two most security-critical pure computations, isolated + exhaustively tested: **`min_out_floor`** (7: 1:1, slippage haircut, confidence-conservative lower-price⇒more-out, exponent scaling, decimal mismatch, dust-floor rejection, overflow-without-panic) and **`redeem_payout`** (7: exact share, rounds-down/never-overpays, full redeem, dust→0, floor-preserved sum-within-balance, zero-supply→err, overflow-guarded). Run: `cargo test -p solum --features no-entrypoint`. |

**Property-based fuzzing.** `tests/fuzz-invariants.ts` runs randomized, seeded (reproducible)
sequences of deposit / redeem / transfer against the program on a validator, and after **every**
operation asserts the on-chain state equals an independent off-chain reference model (exact
BigInt) and that four invariants hold: **I1** conservation (vault + Σ holders == deposited),
**I2** floor-monotonicity (reserves / supply never decreases), **I3** redeem-exactness (payout ==
⌊N·bal/supply⌋, burn == N), **I4** supply integrity. The harness is validated with a **negative
control** — an injected model error is caught on op #0 — so a green run is meaningful, not
toothless. Campaigns to date: 3,600 ops (12 episodes, varied stock/decimal/holder configs) plus a
fresh **1,200-op / 10-episode** run (base seed 20260721, all-independent seeds) — **zero invariant
violations.** Configurable via `FUZZ_EPISODES` / `FUZZ_OPS` / `FUZZ_SEED`.

## Internal review (2026-07-20) — findings found and fixed

An independent adversarial pass (fresh reviewer) found three issues, all now fixed and covered by `tests/standalone-hardening.ts`:

1. **HIGH — permissionless `initialize_vault` front-run.** Config/vault PDAs keyed only on `token_mint` let anyone win the init and set a hostile venue/admin. **Fixed:** PDAs are now bound to `(token_mint, admin)`, so a vault is uniquely its creator's and cannot be hijacked; a front-runner only ever gets their own separate vault.
2. **HIGH — unconstrained `add_backing` funding asset.** The engine could feed a vault *stock* reserve in as "funding" and swap it out under a dimensionally-broken floor. **Fixed:** `funding_mint` is pinned in config (and may never be a stock); `add_backing` requires `funding_mint == config.funding_mint`.
3. **MEDIUM — global oracle pollution.** `PriceFeed` was a per-stock singleton any admin could write. **Fixed:** feeds are per-vault (seeded by config) and `set_price` requires the stock be in that vault's allowlist.

A second round (two independent reviewers) found two more, both fixed and covered by tests:

4. **HIGH — redemption freeze.** `redeem` refused to run while `paused`; a compromised admin could freeze the floor forever. **Fixed:** redemption is no longer pausable — `paused` gates only the value-adding `add_backing`. Proven: `standalone-redeem.ts` now asserts redeem succeeds *while paused*.
5. **HIGH — venue could leave a delegate.** `add_backing`'s balance-delta guard didn't catch a hostile venue using the vault signature to `approve`/`set_authority` on a vault account (balances unchanged, drain later). **Fixed:** post-CPI, both vault accounts must be untampered — still vault-owned, no delegate, no close-authority. Proven by a rug-mode mock venue in `standalone-backing.ts`.
6. **LOW — dust floor / fail-open check.** `add_backing` now rejects a floor that rounds to zero, and the "reject vault-owned venue account" check fails *closed* on a parse error.

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
6. **Transfer-hook stocks (availability):** `redeem`'s `transfer_checked` does not resolve a
   Token-2022 *transfer-hook*'s extra accounts, so allowlisting a hooked stock would make
   redemption revert for the whole vault. **Do not allowlist transfer-hook stocks** (transfer
   *fee* stocks are fine — the redeemer simply nets less). Pre-mainnet: either make `redeem`
   hook-aware or reject hooked mints at `initialize_vault`. All allowlisted stocks in one vault
   must share one token program (Token-2022 for xStocks).
7. **Canonical vault (phishing):** a vault is keyed by `(coin, creator)`, so anyone can stand up
   a look-alike vault for a coin with themselves as admin. The *real* vault must be identified
   off-chain by the creator's pubkey — front-ends must resolve vault-by-`(coin, creator)`, never
   by coin alone. A look-alike cannot harm the legitimate vault; it can only mislead a user into
   redeeming against thin backing.

## Build / verify
`anchor build` (pins in `Cargo.lock` for the 1.79 SBF toolchain). Tests: start
`solana-test-validator`, fund the wallet, `anchor deploy --provider.cluster localnet`, then run
the standalone suites (see [`TESTING.md`](TESTING.md)).
