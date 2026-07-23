# Verify a draw yourself

Every Solum draw leaves a public trail. You don't have to trust us — here's how to confirm, from
public data, that a given hour's winner was chosen fairly.

## What each draw produces

1. **A published snapshot** — the full list of holders and their ticket ranges for that hour,
   `{ owner, start, tickets }`, plus the Merkle `root` and `total`. Published to
   `snapshots/epoch-<hourStart>.json`.
2. **`commit_epoch`** (on-chain) — writes that `root` and `total` into the jackpot account.
3. **`settle_draw`** (on-chain) — writes the `winning_ticket`, taken from Switchboard VRF (or
   injected randomness on devnet). No one can predict or grind it.
4. **`claim_prize`** (on-chain) — pays the whole pot to the holder whose range contains the winning
   ticket, and only to that holder's own wallet.

## The three things you check

1. **The committed root really is the published holders.** Re-hash every leaf
   (`keccak(0x00 ‖ owner ‖ start ‖ tickets)`), fold the sorted tree, and confirm the root equals the
   one written on-chain. If a single holder or ticket count were altered, the root wouldn't match.
2. **The ticket ranges are honest.** They must be contiguous from `0`, with no gaps or overlaps, and
   sum to `total`. So nobody was given phantom tickets or skipped.
3. **The winner is the one the ticket points to.** `winning_ticket` must fall inside exactly one
   holder's `[start, start+tickets)` range — that holder, and no one else, can be paid.

## Do it in one command

```
SOLUM_JACKPOT=<jackpot pubkey> SOLUM_RPC=<rpc> \
  node automation/verify-draw.js snapshots/epoch-<hourStart>.json
```

`verify-draw` re-derives the root from the snapshot, fetches the on-chain jackpot state, and prints
`PASS`/`FAIL` for each check plus the winner. It's the same code the tests exercise
(`automation/verify-draw.test.ts`, which also proves it *rejects* tampered snapshots, out-of-range
tickets, range gaps, and mismatched totals).

## Why this is enough

The only off-chain input to a draw is *who held how much* — and that is itself recomputable from the
coin's public transfer history, so a dishonest snapshot is verifiably wrong and would fail check (1).
Everything else — the randomness, the winning ticket, and the payout gate — is on-chain. The pot is
a program-derived account with no private key and no withdraw path, so value can only ever leave via
a payout to the drawn holder's own wallet.
