# Solum mainnet launch — turnkey runbook

Everything below is built, tested on devnet (41 tests), and merged to `main`. **Order of operations:
stand up and PROVE the entire rig on mainnet FIRST; launch the $SOLUM token LAST.** Expectations spike
the moment the token is live, so nothing is left unverified for launch day — by then it's just "init the
real jackpot with the mint and flip it on."

## Two phases

- **Phase A — advance setup (before the token):** deploy the program, prove the live Switchboard oracle
  against a THROWAWAY test jackpot (its own PDA — a test coin, separate from the real one), stand up the
  host + bot + claim service + payout console, wire the dev wallet + the 5 stock mints. Everything green.
- **Phase B — launch day (final step):** you launch $SOLUM → send the mint → I init the REAL jackpot with
  it, point the bot at it, run one full real cycle, flip the DEVNET label, open to the public.

## Phase A — you provide NOW (to set everything up before the token)

1. **A funded mainnet deploy wallet (~5–6 SOL)** + its keypair path/secret. Real SOL — program rent + the
   test-draw accounts.
2. **The Solum-side host** (server/VM under the Solum identity — NOT the Magpie Railway account). Runs the
   bot + claim service + serves `status.json`/`winners.json`.
3. **Dev/creator wallet key** = `ALUM6Y7rfVBDRB1P1xuoTkSECnVF6uRmP4E53B2DEt5Q`, delivered as a host secret
   (`SOLUM_OPS_KEY=/secure/ops.json` or a Railway secret) — **never** pasted in chat/committed.
4. **The 5 Sunrise xStock mainnet mints** (AAPLx / NVDAx / TSLAx / COINx / MSTRx) as `SOLUM_STOCKS` (JSON:
   label → {mint, opsAccount, tokenProgram}; ops account = the dev wallet's ATA, auto-created on first buy).

## Phase A — I run (autonomous)

1. **Deploy the production program to mainnet** (builds `pyth-oracle switchboard-vrf` via
   `cargo build-sbf --tools-version v1.50` + the pinned Cargo.lock):
   ```
   SOLUM_WALLET=/secure/deploy.json SOLUM_RPC=https://api.mainnet-beta.solana.com \
   SOLUM_CONFIRM=I_HAVE_AUDIT_AND_LEGAL ./scripts/deploy-mainnet.sh
   ```
2. **Prove the live Switchboard oracle** — init a **throwaway test jackpot** (its own PDA, a test coin,
   fully separate from the real one), create the Switchboard queue reference + randomness account, and run
   a real `request_draw → reveal → settle_draw`. This verifies the one path devnet couldn't. Test jackpot
   is then discarded.
3. **Stand up the host:** deploy the **bot (configured, NOT started** — it waits for the real mint), the
   **claim service** (`claim-server`, TLS + CORS = solum.work), and the **payout console** (`ops-dashboard.html`).
4. **Wire the dev wallet + 5 stock mints;** dry-run a Jupiter buy-quote to confirm routing.
5. **Stage the site cutover** — feeds ready, DEVNET label still on.
   → **End of Phase A: everything deployed, the live oracle proven, nothing left but the token.**

## Phase B — launch day (final step, you trigger)

6. You launch **$SOLUM** on pump.fun → send the **mint address**.
7. I **init the REAL jackpot** with the $SOLUM mint + the 5 stock mints, point the bot at it
   (`SOLUM_COIN_MINT`), and **start it** (`SOLUM_VRF=switchboard`, `SOLUM_COUNTDOWN=300`).
8. Watch one full real cycle publish clean `status.json`/`winners.json`; confirm the site's live feed
   (fee ledger, 5-min countdown, advertised prize, real-winner reel).
9. **Flip the DEVNET label off → open to the public.**

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
