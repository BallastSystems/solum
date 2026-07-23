# Claim + award — the winner claims, you deliver within 24 hours

How a winner receives their prize, and how you run the pieces.

## The model

1. **Every hour** a winner is drawn on-chain (Switchboard VRF over the committed holder snapshot).
   The draw is public and verifiable. The bot records the winner in `winners.json` (published to the
   site). No funds move.
2. On the site, the winning wallet sees a **Claim** button **right away** (it is not time-locked).
3. The winner clicks Claim, connects their wallet, and **signs** a short message. This **records the
   claim** and starts a **24-hour countdown**, with a clean disclaimer: *"You'll be awarded within 24
   hours."* Claiming is **required** — you only deliver to winners who claimed.
4. **You manually send** the tokenized-stock prize from the review wallet within that 24h, using the
   award CLI. Once sent, the site shows **Awarded ✓** with a transaction link.

The on-chain program is **draw-only** — it proves *who won*. Custody and delivery are yours: the stock
stays in your wallet, and you release it on your own schedule within the 24h window.

## Two pieces (`automation/claim.ts`, 10/10 adversarial tests)

**`registerClaim`** (winner-initiated, via the claim service) — records a claim only when: the
signature **verifies** against the winner's pubkey, the message is **epoch-bound** and **≤15 min old**
(no replay), and the wallet is the **drawn winner**. It sets `claimed` + `claimedAt`. No funds move.
Idempotent.

**`awardPrize`** (operator-run, via the award CLI) — sends the **exact** recorded prize from the ops
wallet to a **claimed** winner, marks it `awarded` + `awardTx`. Rejects unclaimed winners, pays the
exact amount, and is idempotent + single-send-locked (never double-pays).

## Run the claim service (records claims)

Holds the ops wallet (to know the custody pubkey) — the key stays in the environment, never the repo.

```
SOLUM_RPC=https://api.mainnet-beta.solana.com \
SOLUM_OPS_KEY=/secure/ops-wallet.json \        # SECRET
SOLUM_STOCK_MINT=<mint> SOLUM_OPS_STOCK_ACCT=<ops stock ATA> \
SOLUM_STOCK_PROGRAM=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
SOLUM_WINNERS_FILE=/data/winners.json SOLUM_SITE_ORIGIN=https://solum.work PORT=8787 \
  node target/build/claim-server.js
```

`POST /claim` (`{epoch, winner, message, signature}` → `{ok, claimedAt, awardWithin}`), `GET /health`.
CORS limited to `SOLUM_SITE_ORIGIN`. Put it behind TLS.

## Deliver prizes (you, manually)

```
node target/build/award.js            # list winners who claimed and are awaiting delivery
node target/build/award.js <epoch>    # send that winner's prize
node target/build/award.js --all      # send every pending prize
```

Same env as the service. This is your **manual send** — review who claimed, then release. It only ever
pays a claimed winner, the exact amount, once.

## Point the site at the claim service

In `winners/index.html`, set `CLAIM_ENDPOINT` to the service URL (e.g. `https://claims.solum.work`).
Empty = preview (the button verifies the wallet + signs, shows "awarded within 24h", but nothing is
recorded server-side). Setting the URL makes claims real; you then deliver with the award CLI.

## Notes

- Per-stock rotation: configured for one stock mint + ops token account. For the full 5-stock rotation,
  run one config per stock, or extend to resolve the mint from the winner entry's `stock` field.
- Unclaimed winners: with claiming required, a winner who never claims isn't paid — you can leave the
  prize in the pool to roll forward, or deliver at your discretion.
- Legal: custodying pooled tokenized-securities prizes and releasing them at your discretion is
  securities/custody-flavored. US geo-block + non-US entity + counsel before mainnet remain mandatory.
