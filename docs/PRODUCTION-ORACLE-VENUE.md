# Production wiring — Pyth oracle + real venue adapter (DRAFT)

Status: **design draft, not yet built or tested.** Replaces the two devnet stand-ins called out
in [`AUDIT.md`](AUDIT.md) §Assumptions: the admin `set_price` oracle and the mock swap venue.
Nothing here changes the core invariant — `add_backing` still ends with the same net-effect guard
(reload both vault accounts, require stock ↑ ≥ floor and funding ↓ ≤ amount_in, no tamper). Only
(a) *where the floor price comes from* and (b) *what program the swap CPIs* change.

---

## 1. Pyth oracle (replaces `set_price` / `PriceFeed`)

### What changes
Today `add_backing` reads a per-vault `PriceFeed` PDA that an admin wrote via `set_price`. In
production it reads a **Pyth pull-oracle `PriceUpdateV2`** account instead, and the admin only ever
binds a stock to a *feed id* (not a price). The `fair_out` math is byte-for-byte the same — Pyth's
`(price, exponent)` maps directly onto the existing `(pf.price, pf.expo)` convention (exponent ≤ 0).

### Dependency
```toml
# programs/ballast/Cargo.toml
pyth-solana-receiver-sdk = "0.6"   # PriceUpdateV2, get_price_no_older_than, feed_id parsing
```
> ✅ **BUILD RISK — RESOLVED (spiked 2026-07-21).** Added `pyth-solana-receiver-sdk = "0.6.1"` and a
> throwaway `oracle_probe` instruction that actually calls `get_price_no_older_than`, then ran
> `anchor build` on the pinned 1.79 SBF toolchain. Result: **clean build, zero errors, no crate
> pins needed.** The SDK resolves against anchor 0.31.1 / solana 2.1 (no version conflict),
> `pyth-solana-receiver-sdk 0.6.1` + its `pythnet-sdk 2.3.1` dep compile on rustc 1.79, and the
> API links into a callable instruction (the `.so` grew 369,048 → 381,288 bytes, proving real
> linkage, not dead-stripping). No platform-tools bump required. The probe was reverted; this doc
> records the result.

### Storage change — bind a stock to its Pyth feed id
Replace the price-carrying `PriceFeed` with a config-only `StockOracle` PDA (same
`(config, stock_mint)` seeds, so no cross-vault pollution):
```rust
#[account]
#[derive(InitSpace)]
pub struct StockOracle {
    pub stock_mint: Pubkey,
    /// Pyth price-feed id for STOCK / <funding-unit> (32 bytes). Set once by admin.
    pub feed_id: [u8; 32],
}

pub const MAX_PRICE_AGE_SECONDS: u64 = 60;  // time-based (Pyth publish_time), not slots
```
`set_price(price, expo)` → `set_feed(feed_id: [u8;32])` (admin-signed, stock ∈ allowlist). Same PDA
seeds, same allowlist guard; it just stores an id instead of a price.

### Handler change — read Pyth, be confidence-conservative
```rust
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

// in AddBacking accounts: drop `price_feed: Account<PriceFeed>`, add:
//   pub stock_oracle: Account<'info, StockOracle>,   // seeds [ORACLE_SEED, config, stock_mint]
//   pub price_update: Account<'info, PriceUpdateV2>,

let so = &ctx.accounts.stock_oracle;
let pu = &ctx.accounts.price_update;
// verifies the update is for THIS stock's feed AND fresh (publish_time within MAX_AGE):
let p = pu.get_price_no_older_than(&Clock::get()?, MAX_PRICE_AGE_SECONDS, &so.feed_id)
        .map_err(|_| BallastError::StaleOracle)?;
// Protect the vault: use the LOWER bound of the stock price (price − conf) so we require MORE
// stock out, never less. Reject non-positive / absurd exponent.
let conservative = (p.price as i128).saturating_sub(p.conf as i128);
require!(conservative > 0, BallastError::BadOracle);
require!(p.exponent <= 0 && p.exponent >= -18, BallastError::BadOracle);
let price = conservative as u128;
let pe = (-p.exponent) as u32;
// …then the EXISTING fair_out / floor formula, unchanged, using `price` and `pe`.
```

### The funding-unit gotcha (important)
`fair_out` needs the stock price **in the funding asset's units**. Two cases:
- **Funding = USDC** → a single `STOCK/USD` Pyth feed is exactly right. **Recommended for the swap
  path** — one feed, one account, simplest to audit.
- **Funding = wSOL** → `STOCK/USD` alone is wrong (you'd treat SOL as $1). You must combine two
  feeds: `STOCK/USD` and `SOL/USD`, deriving stock-in-SOL = stock_usd / sol_usd. That's a second
  `PriceUpdateV2` account and one more division (both confidence-conservative). Draftable, but do
  USDC-funding first.

`deposit_stock` (the primary manual-buyback path) **uses no oracle at all** and is unaffected by
any of this.

### Keep the devnet path behind a feature
Gate the old admin oracle so local tests still run without a Pyth receiver:
```rust
#[cfg(feature = "devnet-oracle")] // set_price + PriceFeed compiled in for local validator tests
#[cfg(not(feature = "devnet-oracle"))] // Pyth path for devnet/mainnet
```

---

## 2. Real venue adapter (replaces `mock-venue`)

### Keep the core untouched
`add_backing` CPIs whatever program is allowlisted as `config.swap_venue`, passing
`[vault_authority(signer), funding_vault(w), stock_vault(w), ..pool accounts]` and calling
`swap(amount_in)` (discriminator `sha256("global:swap")[..8]`). **The audited Ballast program does
not change.** We just build a thin **adapter program** that implements that same ABI and CPIs a
real DEX. Allowlist the adapter's program id; the net-effect guard still bounds it — a buggy or
hostile adapter can waste a transaction but can never drain the vault or leave a delegate.

### Venue ABI v1 (recap — the adapter must honor exactly this)
```
swap(amount_in: u64)
accounts[0] vault_authority  (signer, provided by Ballast via invoke_signed)
accounts[1] funding_vault    (writable) — pull EXACTLY amount_in from here
accounts[2] stock_vault      (writable) — deposit ALL swap output here
accounts[3..] the DEX's own pool accounts (Ballast forwards these from remaining_accounts)
```

### Option A — Raydium CPMM adapter (recommended first)
Single-pool, one clean CPI, easiest to reason about. The adapter:
1. Takes `[vault_authority, funding_vault, stock_vault, ..raydium_cpmm_accounts]`.
2. CPIs Raydium CPMM `swap_base_in(amount_in, minimum_amount_out=0)` — output goes to
   `stock_vault`. (min_out is 0 at the adapter; **Ballast's oracle floor is the real slippage
   bound**, enforced after the CPI returns.)
3. Returns. Ballast reloads and enforces the floor.

Skeleton:
```rust
// programs/venue-raydium/src/lib.rs
pub fn swap(ctx: Context<Swap>, amount_in: u64) -> Result<()> {
    // vault_authority signed the outer ix; forward it as the input-owner to Raydium.
    let cpi_accounts = /* Raydium CPMM SwapBaseIn: authority, amm pool, funding_vault(in),
                          stock_vault(out), pool vaults, observation, token programs … */;
    raydium_cpmm::cpi::swap_base_in(
        CpiContext::new(ctx.accounts.raydium_program.to_account_info(), cpi_accounts),
        amount_in,
        0, // min_out enforced by Ballast, not here
    )
}
```
Constraint: a Raydium CPMM pool must exist for the exact `(funding_mint, stock_mint)` pair. xStocks
have on-chain DEX liquidity (per DexScreener), but confirm the venue/pair before allowlisting.

### Option B — Jupiter adapter (best routing, heavier)
Jupiter aggregates across pools = better price, but the route (which pools) is computed **off-chain**
and passed as accounts + data. The adapter forwards Jupiter's `route`/`shared_accounts_route`
instruction, with the vault_authority as the user-transfer-authority and `stock_vault` as the
destination. More accounts, route can change between quote and execution — but the oracle floor +
net-effect guard still make a bad fill revert. Use once the CPMM path is proven.

### Why `deposit_stock` stays primary
Under the locked model (manual buybacks, keep 100% creator fees), the creator buys stock in the UI
and calls `deposit_stock` — no venue, no oracle, trust-minimal. `add_backing` + the adapter are the
*optional* auto-swap path for creators who want the program to do the buy. Ship deposit_stock-first;
the adapter is additive.

---

## 3. Build + test + audit plan
1. **Spike the Pyth dep build** on the 1.79 toolchain (the one real unknown). Pin or bump if needed.
2. Implement the Pyth path behind `#[cfg(not(feature="devnet-oracle"))]`; keep `set_price` for local.
3. On **public devnet**: deploy Ballast + the Raydium adapter; bind real Pyth feed ids; run
   `add_backing` against a real Pyth `PriceUpdateV2` and a real CPMM pool.
4. Extend the adversarial suite + fuzzer for the Pyth path: **stale update** (> MAX_AGE), **wide
   confidence** (near-zero conservative price), **feed-id mismatch**, **exponent out of range**.
5. Audit **both** the Ballast core (unchanged, but re-confirm) **and** the new adapter program.
6. Only then: mainnet, with a non-upgradeable program or a Squads-held upgrade authority.
