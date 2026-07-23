# Claim fulfillment — the 24-hour hold + winner claim

How a winner actually receives their prize, and how to run the service that pays them.

## The model

1. **Every hour** a winner is drawn on-chain (Switchboard VRF over the committed holder snapshot). The
   draw is public and verifiable — anyone can replay it. The bot records the winner + a 24h
   `claimableAt` in `winners.json` (published to the site). It does **not** pay yet.
2. The tokenized-stock prize for that hour stays in the **review (ops) wallet** — your custody window.
3. On the site, the winning wallet sees a **Claim** button under a live **24-hour countdown**. It is
   physically un-clickable until the countdown ends.
4. At zero, the winner connects their wallet, signs a short claim message, and the **claim service**
   sends the exact prize straight from the ops wallet to them, then stamps the record `Claimed ✓`.

The on-chain program is **draw-only** here — it proves *who won*. Custody and payout are yours. What
protects the winner is: the win is provably on-chain the moment it's drawn, and the service will only
ever pay **that** wallet.

## What the service guarantees (`automation/claim.ts`, 9/9 adversarial tests)

`fulfillClaim()` pays **only** when all of these hold, and rejects everything else:
- the request carries a signature that **verifies** against the winner's pubkey (winner-initiated),
- the signed message is **bound to the epoch** and **recent** (≤15 min — no replay of an old signature),
- the wallet is the **drawn winner** for that epoch (from the published record),
- the **24-hour hold has elapsed** (server clock, not the client's),
- it has **not been claimed** already (idempotent — a re-claim returns the existing tx, never double-pays),
- a per-epoch **lock** prevents two concurrent requests from both sending.

It pays the **exact** recorded base-unit amount, from the ops wallet, to the winner's own token
account (created if needed).

## Run the service

The service holds the **ops/custody wallet key** — set it from the environment, **never** commit it.

```
# build once
npx tsc automation/*.ts --outDir target/build --module commonjs --target es2020 \
  --esModuleInterop --resolveJsonModule --skipLibCheck --moduleResolution node --lib es2020,dom

# run (mainnet example)
SOLUM_RPC=https://api.mainnet-beta.solana.com \
SOLUM_OPS_KEY=/secure/ops-wallet.json \        # SECRET — the custody wallet keypair file
SOLUM_STOCK_MINT=<stock mint> \
SOLUM_OPS_STOCK_ACCT=<ops wallet's stock token account> \
SOLUM_STOCK_PROGRAM=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
SOLUM_WINNERS_FILE=/data/winners.json \
SOLUM_SITE_ORIGIN=https://solum.work \
PORT=8787 \
  node target/build/claim-server.js
```

Endpoints: `POST /claim` (`{epoch, winner, message, signature}` → `{ok, claimTx}` or `{ok:false, reason}`),
`GET /health`. CORS is limited to `SOLUM_SITE_ORIGIN`.

Put it behind TLS (a reverse proxy / platform HTTPS). The service and the draw bot (`run.ts`) share the
same ops wallet + `winners.json`, so run them alongside each other.

## Point the site at it

In `winners/index.html`, set `CLAIM_ENDPOINT` to the service's public URL (e.g.
`https://claims.solum.work`). While it's empty, the Claim button runs in **preview** mode — it connects
and verifies the wallet but doesn't pay ("claiming goes live at launch"). Setting the URL makes claims
real.

## Notes

- Per-stock rotation: the service is configured for one stock mint + ops token account. For the full
  5-stock rotation, run one config per stock (or extend the service to resolve the mint from the
  winner entry's `stock` field + a mint table).
- Legal: you are custodying pooled tokenized-securities prizes and releasing them at your discretion
  during the hold — this is securities/custody-flavored. US geo-block + non-US entity + counsel before
  mainnet remain mandatory.
