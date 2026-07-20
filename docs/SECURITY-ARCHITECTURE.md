# Ballast — Security Architecture

> The protocol holds **real assets** on behalf of thousands of holders. The vault is a
> honeypot. Every design decision below exists to make theft **structurally impossible**,
> not merely discouraged. Devnet-only until a top-tier audit + legal review clears mainnet.

## The one invariant everything hangs on

**No instruction can move a vault asset anywhere except:**
1. **a user redeeming their OWN pro-rata share** — user-signed, backed by an equal token burn; or
2. **a swap that ADDS backing** — input → allowlisted stock → the vault PDA, verified.

There is **no admin drain, no engine drain, no upgrade drain of user assets.** The engine
authority can only *trigger add-backing*; it can **never extract value, even if its key is
fully compromised.** This is the exact failure we watched break elsewhere (an engine that
*could* extract collateral because the post-check was caller-supplied). Here, extraction is
not gated — it does not exist as a code path.

## Mechanism (v1): Token-2022 transfer fee → stock backing

- The launched token is a **Token-2022 mint with the Transfer-Fee extension.** A fixed % of
  every transfer is withheld at the token level (protocol-enforced, works on any DEX —
  Jupiter/Raydium — with no custom AMM).
- **Both authorities are a Ballast program PDA**, never a human key:
  - `TransferFeeConfig` authority (can adjust rate within a hard-capped range) = `config_authority` PDA.
  - `WithdrawWithheld` authority (can move withheld fees) = `fee_authority` PDA.
  - ⇒ withheld fees can *only* be routed by the program, *only* into the vault flow. The
    engine cannot sweep withheld fees to itself.
- **Creator fees are untouched** — this is a *separate* transfer fee, not the launchpad's
  creator fee. The creator keeps 100% of theirs. (The wedge.)

## Accounts

- `VaultConfig` (PDA, per token): `token_mint`, `backing_fee_bps` (≤ hard cap), `engine`
  (authority allowed to trigger add-backing), `admin` (multisig; params only), `stock_allowlist`
  (Vec<Pubkey>, the only mints the vault may hold), `swap_venue_allowlist` (program ids, e.g.
  Jupiter), `paused` flag, bumps. **No field grants anyone withdrawal rights over the vault.**
- `Vault` treasury = per-stock **token accounts owned by a `vault_authority` PDA** (PDA-owned,
  so only program CPI with the right seeds can move them, and only via `redeem`/`add_backing`).

## Instructions & guards

| ix | signer | what it may do | hard guards |
|----|--------|----------------|-------------|
| `initialize_vault` | creator/admin | one-time setup | rate ≤ cap; allowlists sane; engine/admin set; PDAs derived, not passed |
| `add_backing` (harvest→swap→deposit) | **engine** | pull withheld fees, swap to an allowlisted stock, deposit to vault | (1) output mint ∈ `stock_allowlist`; (2) swap program ∈ `swap_venue_allowlist`; (3) destination == vault ATA (PDA-owned) for that stock; (4) **reload vault balance after the swap and require it increased by ≥ an oracle-derived min-out floor** (defeats no-op / self-dealing swaps); (5) input fully consumed |
| `redeem` | **holder (user)** | burn N tokens, receive pro-rata slice of *every* stock in the vault | pro-rata = `N * vault_balance / total_supply`, **rounded DOWN** (never over-pay); burn happens **before** transfer; per-stock checked math; can never exceed caller's share |
| `set_params` | **admin (multisig)** | change rate (≤cap) / allowlist / pause | **cannot touch vault balances**; timelock on allowlist adds |
| `sweep_dust` (optional) | engine | consolidate rounding dust **into** the vault | destination == vault only |

Note there is deliberately **no** `withdraw`, `admin_withdraw`, `emergency_withdraw`, or
`sweep_to(address)` instruction. Pausing halts *new backing/redemptions*; it can never move
assets out.

## Threat model → defense

- **Compromised engine key** → worst case: it triggers `add_backing` with a hostile swap
  route. Defense: output-mint allowlist + venue allowlist + destination==vault + post-swap
  balance-increase ≥ oracle min-out. It cannot send value anywhere but the vault. It cannot
  redeem (that's user-signed). **No value leaves.**
- **Malicious / no-op swap route** (the FILL/oracle-drain class) → the reload-and-require-
  increase check makes a no-op or self-dealing route *fail*, not silently pass.
- **Redemption drain** (rounding, double-spend, over-redeem) → burn-before-transfer, round
  down, checked u128 math, pro-rata bounded by `total_supply`. Reentrancy is not a Solana
  concern, but state transitions are ordered defensively anyway.
- **Withheld-fee theft** → withdraw-withheld authority is a PDA; no human key can pull it.
- **Allowlist poisoning** (adding a fake "stock" mint to drain via swap) → allowlist adds are
  admin (multisig) + timelocked + emit events; the swap min-out uses the *intended* asset's
  oracle.
- **Upgrade attack** → program is **non-upgradeable at mainnet** (or upgrade authority = a
  Squads timelock multisig), and even an upgrade can't retroactively add a drain path without
  a public, timelocked, auditable change. User assets in PDAs are not silently reachable.

## Non-negotiables

1. **Devnet-only** through development. No mainnet deploy, no real assets, until audited
   (Sec3 / OtterSec tier) **and** legally reviewed (the securities/redemption question).
2. **Every real-asset path is program-enforced**, never engine-discretionary.
3. **Proof-of-reserves is on-chain-native** — the vault balances *are* the reserves; the app
   just reads them. No off-chain "trust us."
4. **Checked math everywhere**; round in the protocol's favor; deny-by-default on allowlists.
5. **No secrets, no real-name, no linkage to any other protocol or to the operator's
   identity** in any file, commit, or deploy. This project stands entirely alone.

## Build order (each step reviewed + devnet-tested before the next)
1. `VaultConfig` + `Vault` accounts + `initialize_vault` (+ tests).
2. `redeem` (the floor) — the most security-critical user path (+ adversarial tests).
3. `add_backing` swap CPI + the reload/min-out guard (+ adversarial tests).
4. Token-2022 transfer-fee wiring (authorities = PDAs).
5. Engine (off-chain trigger only; holds no extraction power).
6. Proof-of-reserves dashboard.
7. Audit → legal → (only then) mainnet.
