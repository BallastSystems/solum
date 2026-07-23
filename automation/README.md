# Solum draw bot

The hourly automation that runs the raffle end to end. Devnet-only, pre-audit.

## The loop (`run.ts`)

Each hour:
1. **Track holders** — subscribe to every $SOLUM token account and fold balance changes into a
   **TWAB** accumulator (`twab.ts`), so odds are each holder's *average* balance over the hour.
2. **Fund the pot** — from the operator's **fee/dev wallet**, collect pump.fun **creator fees** (SOL)
   and, at **random moments**, swap them to tokenized stock via Jupiter on the operator's behalf
   (`fees.ts`). More volume → more fees → bigger buys. (The bot holds only this funding wallet.)
3. **Draw at a random moment** — at an unpredictable time in the draw window: snapshot the TWAB into
   ticket ranges + a Merkle root (`twab.ts` + `merkle.ts`), `commit_epoch`, and settle from
   **Switchboard VRF**, which fixes the winning ticket **on-chain** (public + verifiable). The bot
   then **records a pending claim** for the proven winner — it does **not** pay (`draw.ts` + `run.ts`).
4. **Deliver — hold-and-manually.** The winner **claims** (connects + signs; required + recorded),
   which starts a **24-hour window**; the **operator** then **manually sends** the exact
   tokenized-stock prize from their own custody wallet (`claim.ts` + `award.ts`, see `docs/CLAIM.md`).
   The on-chain draw only proves *who won* — **custody and delivery stay fully with the operator.**
5. **Publish** the full snapshot (`snapshots/epoch-*.json`) so anyone can recompute the root from
   on-chain history and verify the draw.

## Why it can't be exploited

- **TWAB** — a last-second whale earns ~1% weight, not a full allocation (`twab.test.ts`).
- **Random draw time** — you can't know when the draw fires.
- **Switchboard VRF** — the winning ticket is oracle-revealed; no one can predict or grind it.
- **Merkle + range check** — the winning ticket resolves to exactly one proven holder, so the operator can only ever deliver the recorded prize to that wallet.

## Custody & control

The bot **funds and draws**; the **operator delivers**. The draw bot only ever holds the **fee/dev
wallet** — used to collect creator fees and buy tokenized stock on the operator's behalf — and it
records the proven winner each hour. It **never** sends a prize to a user. Every payout is a **manual**
send by the operator from their custody wallet, within 24h of the winner claiming, so the operator
stays in full control of who is paid and when. The funding-wallet key is provided to the bot as a host
secret (env var / keyfile), never committed to git; keep it a **dedicated** wallet holding only
operating funds, funded incrementally — never a main wallet.

## Files

| File | Role |
|---|---|
| `twab.ts` | TWAB accumulator → ticket ranges → snapshot |
| `merkle.ts` | keccak Merkle (mirrors the on-chain hashing) |
| `draw.ts` | commit → settle (VRF) → resolve the winning ticket (on-chain draw; `payWinner` = auto-pay mechanic for tests/demo only) |
| `fees.ts` | creator-fee collection → random-time Jupiter buy → fund pot (uses the fee/dev wallet) |
| `claim.ts` | record a winner's claim + the operator's manual award (hold-and-deliver) |
| `award.ts` | operator CLI — manually deliver the exact recorded prize |
| `run.ts` | the hourly scheduler (entry point) |
| `twab.test.ts` | pure unit tests (8/8) |
| `cycle.test.ts` | full draw cycle on a validator (7/7) |
| `stress-500.ts` | 500 independent fee-funded draws + fairness report (win rate vs ticket share) |
| `fuzz-jackpot.ts` | stateful fuzzer — random op sequences vs a reference model (conservation, phase machine) |
| `verify-draw.ts` | independent draw verifier — re-derive the root, confirm the winner (7/7 unit) |
| `status.ts` | publishes status.json + winners.json for the site |

## Run

```
SOLUM_RPC=... SOLUM_OPS_KEY=ops.json SOLUM_COIN_MINT=... SOLUM_ADMIN=... \
SOLUM_STOCK_MINT=... SOLUM_OPS_STOCK_ACCT=... SOLUM_POT_CUSTODY=... SOLUM_STOCK_PROGRAM=... \
node run.js
```

Steps 1 & 3 run today; the pump.fun fee-claim and Jupiter buy in `fees.ts` need mainnet + live
routes (marked in the code). Randomness uses `devnet-vrf` locally; production builds with
`switchboard-vrf`.
