# Solum draw bot

The hourly automation that runs the raffle end to end. Devnet-only, pre-audit.

## The loop (`run.ts`)

Each hour:
1. **Track holders** — subscribe to every $SOLUM token account and fold balance changes into a
   **TWAB** accumulator (`twab.ts`), so odds are each holder's *average* balance over the hour.
2. **Fund the pot** — collect pump.fun **creator fees** (SOL), swap to tokenized stock via Jupiter,
   and transfer it into the pot custody (`fees.ts`). More volume → more fees → bigger buy.
3. **Draw at a random moment** — at an unpredictable time in the draw window: snapshot the TWAB into
   ticket ranges + a Merkle root (`twab.ts` + `merkle.ts`), `commit_epoch`, settle from **Switchboard
   VRF**, then **auto-pay** the winner (`draw.ts`). The winner never has to claim.
4. **Publish** the full snapshot (`snapshots/epoch-*.json`) so anyone can recompute the root from
   on-chain history and verify the draw.

## Why it can't be exploited

- **TWAB** — a last-second whale earns ~1% weight, not a full allocation (`twab.test.ts`).
- **Random draw time** — you can't know when the draw fires.
- **Switchboard VRF** — the winning ticket is oracle-revealed; no one can predict or grind it.
- **Merkle + range check on-chain** — the pot can only reach the proven winner's own wallet.

## Files

| File | Role |
|---|---|
| `twab.ts` | TWAB accumulator → ticket ranges → snapshot |
| `merkle.ts` | keccak Merkle (mirrors the on-chain hashing) |
| `draw.ts` | commit → settle → auto-pay orchestration |
| `fees.ts` | creator-fee collection → Jupiter buy → fund pot |
| `run.ts` | the hourly scheduler (entry point) |
| `twab.test.ts` | pure unit tests (8/8) |
| `cycle.test.ts` | full draw cycle on a validator (7/7) |
| `stress-500.ts` | 500 independent fee-funded draws + fairness report (win rate vs ticket share) |
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
