# Solum — Mechanism Spec (self-funding floor)

Status: **design spec. Devnet-only. No mainnet, no real value, until independent audit + legal
review clear it.** This describes the "self-funding floor" model where a coin's own trading —
not creator charity — grows a redeemable vault of real assets underneath it. The vault + redeem
core already exists (see `SECURITY-ARCHITECTURE.md`, `AUDIT.md`); this doc specifies the funding
loop bolted onto it.

> **Flagship backing: a basket of tokenized blue-chip stocks** (Apple, NVIDIA, Tesla, Coinbase, MicroStrategy). The program is asset-agnostic (an allowlist of mints), so the specific mints a vault allowlists; other real assets are a config choice, not a code change.

## 1. The loop in one picture

```
   trades on a DEX
        │  (Token-2022 transfer fee withheld on every buy/sell)
        ▼
   withheld fee accrues in the coin
        │  harvest_fees  (PDA-signed; only destination is the vault)
        ▼
   vault holds collected coin
        │  add_backing   (sell coin → buy allowlisted stock, oracle-floored)
        ▼
   vault holds REAL tokenized stock  ── floor = vault value / circulating supply
        │  redeem  (holder burns coins → pro-rata slice of the real stock)
        ▼
   holder exits at the floor, anytime, on-chain
```

The floor only rises (deposits only add; redemption is pro-rata and rounds down). No instruction
can move a vault asset out except a holder redeeming their own share — no admin/engine/upgrade
drain path exists.

## 2. The coin

- **Token-2022 mint with the Transfer-Fee extension.** A fixed fee (target **2–3%**, hard-capped
  in code) is withheld on every transfer, including DEX buys/sells.
- **Both fee authorities are program PDAs, never a human key:**
  - `TransferFeeConfig` authority (could change the rate) = a PDA; **no instruction changes the
    rate**, so the tax is frozen.
  - `WithdrawWithheld` authority = a PDA; withheld fees can *only* be routed into the vault flow.
  - ⇒ nobody — not the team, not a compromised key — can raise the tax or sweep the fees.
- Fixed supply; mint authority renounced at launch. Classic memecoin economics on top.

## 3. Funding the floor — two models

**Model A — transfer-fee → convert (buildable now; ~80% already coded).**
The tax accrues *in the coin*. To turn it into real backing, the protocol sells the collected
coin for SOL/USDC and buys allowlisted tokenized stock into the vault (`add_backing`, oracle-
floored). **Honest tradeoff:** converting the tax means selling the coin, i.e. the backing engine
applies continuous sell pressure (~the tax % of volume). Value is not destroyed — it migrates
from *paper market cap* into *real, redeemable vault backing* — but traders feel the sell. Convert
gradually (TWAP-style) to minimize impact. Works on standard Token-2022-aware DEXs (Jupiter/
Raydium) — routing for transfer-fee mints MUST be verified before launch.

**Model B — own-the-venue (bigger build).**
Solum runs the launch venue / bonding curve and takes a **SOL-denominated** slice of each buy
straight into stock, without ever selling the coin. No sell pressure, cleaner economics — but it
requires building a launchpad and bootstrapping liquidity/audience. The scale path, not the start.

## 4. The vault + redemption (already built)

Per-coin vault = per-stock token accounts owned by a `vault_authority` PDA. `redeem` burns N coins
and pays `N · vault_balance / supply` of every stock, computed in u128, rounded **down** (floor
preserved / nudged up for everyone who stays). Redemption is **never pausable**. `deposit_stock`
(permissionless buyback) and `add_backing` (oracle-floored swap) are the only ways value enters,
and both only *increase* the vault. Full guard list in `AUDIT.md`.

## 5. Oracle + venue

- **Oracle:** ✅ **implemented** behind the `pyth-oracle` cargo feature. `set_feed` binds a stock
  to a Pyth feed-id (`StockOracle` PDA); `add_backing` reads a `PriceUpdateV2` via
  `get_price_no_older_than` and uses the **confidence-conservative** lower bound (`price − conf`) for
  the min-out floor. The `default = ["devnet-oracle"]` feature keeps the admin `set_price` path for
  local tests. Both configs build clean on the 1.79 SBF toolchain; the 25-test suite stays green.
  Build prod config: `cargo build-sbf -- --no-default-features --features pyth-oracle`.
- **Venue:** a thin adapter implementing the existing Venue ABI v1, CPI'ing a real DEX (Raydium
  CPMM first). The audited core is unchanged; the net-effect guard bounds a bad adapter.

## 6. The numbers a holder watches

- **Floor** = vault value ÷ circulating supply. Only rises.
- **Coverage** = floor ÷ price. The headline trust metric; climbs as volume accrues backing.
- **Backing** = total real stock in the vault ($). Public, on-chain, recomputable by anyone.

## 7. Optional: the `$SOLUM` protocol token

A protocol-level cut (a small launch fee, or a slice of each coin's backing flow) can buyback-burn
`$SOLUM`, giving the ecosystem a speculative asset and funding operations. Additive; not required
for the per-coin loop to work. Kept out of scope until the core loop is proven + legally cleared.

## 8. Security invariants (extend the existing set)

1. No vault asset leaves except owner-burn redemption. (existing)
2. Redemption can never be paused. (existing)
3. Transfer-fee rate is frozen (no instruction changes it); withheld fees route only to the vault.
4. `add_backing` conversion is oracle-floored + net-effect-guarded; a hostile venue can waste a tx
   but never drain or under-fill.
5. All value math checked u128; rounds in the protocol's favor.

## 9. Reuse map (what's built vs. new)

| Piece | State |
|---|---|
| Vault, `redeem`, `deposit_stock`, `add_backing`, oracle-floor guard | ✅ built + 25 tests + 4,800-op fuzz |
| Token-2022 transfer-fee mint + PDA fee authorities + `harvest_fees` | ✅ built (was shelved under the pump.fun plan) |
| Pyth oracle wiring | drafted; build de-risked |
| Real venue adapter (Raydium/Jupiter) | drafted |
| Convert-loop economics (TWAP sell of collected fee → stock) | **new** |
| Launch UX (mint a transfer-fee coin + open its vault) | **new** |
| DEX routing verification for transfer-fee Token-2022 | **new — must verify early** |

## 10. Hard gates before mainnet

Devnet-only until: (1) the full loop is adversarially tested + fuzzed on public devnet;
(2) transfer-fee-mint DEX routing is verified; (3) independent audit (Sec3 / OtterSec tier) clears
the code; (4) **legal review clears the structure** (the backing-asset choice and the redemption
model are the open questions). No real value at risk before all four.
