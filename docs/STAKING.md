# Solum — Stake-to-Earn module (design spec)

Status: **design + verified core math. Devnet-only, pre-audit.** Adds the "stake your memecoin,
earn real stock" engine on top of the existing vault. The vault + `redeem` core is unchanged; this
is a new, self-contained rewards layer.

## What it does

A memecoin's **creator fees** (SOL that pump.fun pays the creator per trade) are used to buy real
tokenized stock into a **rewards vault**. Holders **stake** (lock) their coins in Solum and accrue
a claimable share of that stock, proportional to **stake amount × time staked**. Longer + larger
stake ⇒ larger share. Claim your real stock anytime; unstake returns your coins.

Non-stakers earn nothing from the rewards vault — that's the incentive to stake (and locking
supply is the anti-dump mechanic).

## Why a reward-per-share accumulator (not naive iteration)

We must distribute a stream of stock to a changing set of stakers **without looping over holders**
(unbounded compute) and **without any staker being able to claim rewards that accrued before they
staked**. The battle-tested pattern is the **MasterChef accumulator**:

- Global, per stock: `acc_reward_per_share` — cumulative reward per staked token, fixed-point
  (`REWARD_PRECISION = 1e12`).
- Global: `total_staked`, and `last_balance` per stock (the rewards-vault balance at the last fold).
- Per staker, per stock: `reward_debt` — the accumulator value already "credited" to this staker,
  so they only ever earn on rewards that arrived **after** they staked.

### The two pure computations (implemented + unit-tested)

```
fold new rewards:   acc' = acc + reward_in · PRECISION / total_staked        // acc_add()
pending for stake:  pending = amount · acc / PRECISION − reward_debt (≥ 0)    // pending_reward()
```

`reward_in` = `current_rewards_vault_balance − last_balance` for that stock (only ever ≥ 0;
deposits only add). When `total_staked == 0` the fold is a **no-op** — undistributable rewards
simply wait in the vault for the next staker (they are never lost, never mis-credited).

Both are `checked` (no overflow, no div-by-zero) and isolated as pure functions so they can be
exhaustively unit-tested — see `min_out_floor` / `redeem_payout` for the same discipline.

## State (per coin)

| Account | Fields |
|---|---|
| `StakePool` (PDA `[b"stake", coin_mint]`) | `coin_mint`, `total_staked`, `stock_count`, `acc_reward_per_share: [u128; MAX_STOCKS]`, `last_balance: [u64; MAX_STOCKS]`, bumps |
| `StakeAccount` (PDA `[b"stake", pool, owner]`) | `owner`, `amount`, `reward_debt: [u128; MAX_STOCKS]` |
| rewards vault | per-stock token accounts owned by the existing `vault_authority` PDA (reuses the audited custody) |

## Instructions

| ix | signer | effect |
|----|--------|--------|
| `init_stake_pool` | admin | one-time; binds the pool to the coin + the vault's stock allowlist |
| `sync_rewards` | anyone (permissionless) | fold `current − last_balance` for each stock into `acc_reward_per_share`; update `last_balance`. Idempotent. |
| `stake` | holder | `sync` first, then transfer `amount` coins into the pool's stake custody, `amount += amount`, `reward_debt = amount · acc / PRECISION` (per stock) |
| `claim` | holder | `sync` first, then for each stock pay `pending_reward(...)` from the rewards vault, reset `reward_debt` |
| `unstake` | holder | `sync` + `claim`, return staked coins, reduce `amount`/`total_staked` |

**Ordering invariant:** every `stake` / `claim` / `unstake` folds rewards (`sync`) *before* touching
`amount` or `reward_debt`, so a staker's `reward_debt` is always set against a current accumulator —
this is what prevents both over-claiming and reward theft on join/leave.

## Security invariants (extend the existing set)

1. A staker can never claim more than `Σ rewards that arrived while they were staked` (accumulator +
   `reward_debt`, all checked u128).
2. `total_staked` equals the sum of all `StakeAccount.amount` (conserved on every stake/unstake).
3. Staked coins live in a program-owned custody with no withdraw path except the owner unstaking
   their own `amount` (same non-custodial guarantee as the vault).
4. Rewards vault only ever *increases* except via a staker's own `claim` — no admin/engine drain.
5. `sync_rewards` is permissionless + idempotent, so rewards can't be stalled by a passive admin.

## Interaction with the existing `redeem`

`redeem` (burn coin → pro-rata slice of the vault) and stake-to-earn are **distinct pools of
stock**: the redeem "floor" backing vs. the staking **rewards** vault are separate token accounts,
so there is no double-counting. A coin can ship with either or both. (For the pump.fun stake-to-earn
product, the rewards vault + staking is the primary mechanism.)

## Build status

- ✅ **Core reward math** (`acc_add`, `pending_reward`) — 10 unit tests (proportional split, no
  pre-stake rewards, zero-staked no-op, overflow-guarded).
- ✅ **All 5 instructions implemented + integration-tested on a validator** (`tests/standalone-stake.ts`,
  **11/11**): stake locks coins in custody; a sole staker earns the full reward stream; two stakers
  split new rewards proportionally (100:300 ⇒ 200:600) while a joiner earns nothing on pre-stake
  rewards; double-claim reverts; claiming another's stake is blocked by the account seeds; unstake
  > staked reverts; unstake returns the staked coins exactly.
- ⏳ Recommended next hardening: a stateful fuzzer for random stake/unstake/claim/fund sequences
  against an off-chain reference model (same discipline as the vault core's I1–I4 fuzzer), then audit.

## Legal note

Paying stakers a real-stock "yield" is **more** securities-flavored, not less. US geo-block + a
non-US entity + securities counsel before any mainnet remain mandatory.
