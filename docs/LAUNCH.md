# Solum mainnet launch — turnkey runbook

Everything below is built, tested on devnet (41 tests), and merged to `main`. The launch is blocked
only on four inputs that must exist first; once they do, the sequence runs end to end with a controlled
test draw *before* going public.

## You provide (4 inputs — only these gate the launch)

1. **$SOLUM launched on pump.fun** → the **mint address** (`SOLUM_COIN_MINT`). Nothing downstream exists
   without this.
2. **Solum-side host** (a server/VM under the Solum identity — NOT the Magpie Railway account). This runs
   the bot + the claim service + serves `status.json`/`winners.json`.
3. **Dev/creator wallet key** = `ALUM6Y7rfVBDRB1P1xuoTkSECnVF6uRmP4E53B2DEt5Q`, delivered as a host secret
   (env `SOLUM_OPS_KEY=/secure/ops.json` or Railway secret) — **never** pasted in chat/committed. This
   wallet collects creator fees + buys the stock; it also deploys unless you use a separate deploy wallet.
4. **~5 SOL** on the mainnet deploy wallet (program rent + fees).

## The 5 tokenized-stock mints

The prizes are Sunrise xStocks (real Token-2022 mints). Provide the mainnet mints for AAPLx / NVDAx /
TSLAx / COINx / MSTRx as `SOLUM_STOCKS` (JSON: label → {mint, opsAccount, tokenProgram}). The ops account
per stock is the dev wallet's ATA (auto-created on first buy).

## I run (autonomous, in order — no further input needed)

1. **Build + deploy the program (production features).**
   ```
   SOLUM_WALLET=/secure/deploy.json SOLUM_RPC=https://api.mainnet-beta.solana.com \
   SOLUM_CONFIRM=I_HAVE_AUDIT_AND_LEGAL ./scripts/deploy-mainnet.sh
   ```
   (Builds with `pyth-oracle switchboard-vrf` via `cargo build-sbf --tools-version v1.50` + the pinned
   Cargo.lock; deploys; prints the program id.)

2. **Initialize the jackpot** against the real $SOLUM mint + the 5 stock mints (mainnet init, one tx).

3. **Switchboard On-Demand:** create the queue reference + randomness account, then **run ONE controlled
   test draw** (`request_draw → reveal → settle_draw`) to prove the live oracle end to end. This is the
   one path devnet couldn't verify — it is verified here, before any public round.

4. **Start the bot** (`SOLUM_VRF=switchboard`, `SOLUM_COUNTDOWN=300`) — fee tracking → hidden random
   snapshot → buy 1 random stock with the cycle's fees → 5-min countdown → VRF draw → winner recorded
   (claim-pending). Watch one full real cycle publish clean `status.json`/`winners.json`.

5. **Claim service + payout console:** start `claim-server` (behind TLS, CORS = solum.work), point the
   site's `CLAIM_ENDPOINT` at it; you review + deliver from `ops-dashboard.html`.

6. **Site cutover:** flip the DEVNET label off, confirm the live feed drives the fee ledger / 5-min
   countdown / advertised prize / real-winner reel.

7. **Open to the public** only after steps 3 + 4 pass.

## Config (env) — filled once inputs arrive

```
SOLUM_RPC=https://api.mainnet-beta.solana.com
SOLUM_OPS_KEY=/secure/ops.json          # dev wallet ALUM…DEt5Q (secret)
SOLUM_COIN_MINT=<pump.fun $SOLUM mint>   # from your launch
SOLUM_ADMIN=<jackpot admin pubkey>
SOLUM_STOCKS='{"AAPLx":{"mint":"..","opsAccount":"..","tokenProgram":"Tokenz.."}, …}'
SOLUM_VRF=switchboard  SOLUM_COUNTDOWN=300  SOLUM_FEE_POLL=20
SOLUM_STATUS_FILE=/data/status.json  SOLUM_WINNERS_FILE=/data/winners.json  SOLUM_FEE_STATE=/data/fee-state.json
```

Audit (OtterSec) + legal are handled by the operator; do not re-gate on them. Host stays Solum-side,
never Magpie.
