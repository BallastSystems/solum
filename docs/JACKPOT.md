# Solum — No-Loss Real-Stock Jackpot (design spec)

Status: **design — pre-implementation. Devnet-only, pre-audit.** Adds the "hold the coin, win
real stock" jackpot on top of the existing undrainable vault. The vault + `redeem` floor is
unchanged; this is a new, self-contained prize layer.

## What it does

A share of every trade's fees buys real tokenized stock into a **prize pot** (a separate custody
from the redeem floor). Every ~4 hours a **winner is drawn**, weighted by how much of the coin they
held and for how long, and can **claim the whole pot** of real stock. **No-loss:** holders never
stake, lock, or risk their coins — they just hold. Losing a draw costs nothing; you keep everything
and roll into the next one.

This is **PoolTogether's model** (time-weighted no-loss lottery) with two twists that make it novel:
the prizes are **real blue-chip stock**, and the same vault also provides a **redeemable floor**.

## The core problem and the proven answer: TWAB

"Just hold, no lock" + a fast (4h) draw invites one attack: **flash-inflate your balance right
before the snapshot, win, then dump.** A single instantaneous balance snapshot is trivially gamed.

The fix (exactly what PoolTogether uses) is **TWAB — Time-Weighted Average Balance**. A holder's
tickets for an epoch = their **average** balance across the whole epoch, not their balance at one
instant. Buying 1M coins one minute before the draw yields ~1 minute of weight out of 240, not a
full ticket allocation. Holding steadily for the full epoch yields the full weight. This makes
last-second inflation worthless and rewards genuine holding.

- Tickets are **linear in balance**, so splitting across N wallets is **neutral** (no sybil gain).
- Whales get proportionally more tickets — a fair raffle by holdings, like a normal lottery.

## Architecture (why part off-chain)

SPL tokens don't record hold-time, and iterating all holders on-chain is unbounded compute. So the
draw is split into an **on-chain trust root** + an **off-chain computation with on-chain
verification** — the standard, safe airdrop/lottery pattern:

```
                    ┌─────────────── on-chain (Solum program) ───────────────┐
 off-chain          │  JackpotState: epoch, twab_root, total_tickets,        │
 snapshotter  ──►   │              vrf_account, pot_custody (PDA, no key),   │
 (posts root)       │              winning_ticket, settled                   │
                    │  ix: commit_epoch(root, total)   [snapshotter]         │
 Switchboard  ──►   │  ix: request_draw()  ──► VRF ──► settle_draw(rand)     │
 VRF (random)       │  ix: claim_prize(merkle_proof)   [winner]             │
                    └────────────────────────────────────────────────────────┘
```

### Off-chain snapshotter (minimal, verifiable)
- Subscribes to coin transfers; maintains each holder's **TWAB** over the rolling 4h epoch
  (`Σ balance·Δt / epoch_len`) — the same accumulator PoolTogether stores on-chain, here computed
  off-chain for a classic-SPL pump.fun coin that can't host it.
- At epoch close, builds a **Merkle tree** of leaves `(holder, cumulative_ticket_start, tickets)`,
  sorted, so each holder owns a contiguous ticket range `[start, start+tickets)`.
- Publishes the **full snapshot** (every leaf) publicly + commits only the **root + total_tickets**
  on-chain. Anyone can recompute the tree from public chain data and verify the root — a wrong root
  is verifiable fraud. (Roadmap: rotating/permissionless snapshotters + a challenge window.)

### On-chain draw (trustless where it counts)
1. `commit_epoch(root, total_tickets)` — snapshotter posts the epoch's Merkle root + ticket count.
2. `request_draw()` — permissionless; asks **Switchboard VRF** for a random value. VRF is
   verifiable and **cannot be predicted or ground** by the snapshotter, the caller, or the team.
3. `settle_draw(rand)` — VRF callback stores `winning_ticket = rand mod total_tickets`.
4. `claim_prize(proof)` — the holder whose ticket range contains `winning_ticket` proves inclusion
   with a Merkle proof and receives the pot. The program checks
   `leaf.start ≤ winning_ticket < leaf.start+leaf.tickets` **and** `verify(proof, root, leaf)`.

The **randomness** (VRF) and the **payout gate** (Merkle range + proof) are fully on-chain and
trustless. The only off-chain component is *who has how many tickets*, and that is publicly
verifiable against on-chain transfer history.

## Pot custody (reuses the audited guarantee)

The pot is a **program-owned token account (PDA), no private key, no withdraw path** — identical to
the redeem vault's non-custodial guarantee. Value leaves **only** via `claim_prize` to the verified
winner. Not the snapshotter, not the team, not a compromised admin can extract it.

## Security invariants (extend the existing set)

1. **No premature/failed draw drains the pot.** `claim_prize` is the *only* outflow, gated by
   VRF-derived `winning_ticket` + a valid Merkle proof against the committed root.
2. **Randomness is unmanipulable.** Switchboard VRF; the winning ticket is fixed by VRF output the
   caller cannot influence. No `request→settle` reentrancy; one settle per epoch.
3. **No double claim.** Epoch marked `claimed` on payout; re-claim reverts.
4. **TWAB defeats flash-balance gaming** (see above); tickets linear ⇒ sybil-neutral.
5. **A bad root is detectable + inert.** Root is public and recomputable; a fraudulent root can be
   proven wrong off-chain, and a challenge window (roadmap) blocks payout on dispute.
6. **No-loss holds.** No instruction ever touches a holder's coins — winning or losing.

## Draw parameters (initial, tunable)

| Param | Value |
|---|---|
| Epoch / draw cadence | **4 hours** (6 draws/day) |
| Tickets | **TWAB** (time-weighted avg balance) over the epoch, linear |
| Fee split | e.g. 60% → redeem floor, 40% → prize pot (config) |
| Randomness | Switchboard VRF |
| Claim window | rolls to pot if unclaimed after N epochs (no value lost) |

## Build status

- ✅ **`JackpotState` + pot-custody PDA; `init_jackpot` / `commit_epoch` / `settle_draw` /
  `claim_prize`** — implemented in `programs/solum/src/lib.rs`, compiles, deployed to a validator.
- ✅ **Merkle verify + ticket-range + VRF mod-reduction as pure functions** — 3 unit tests
  (`winning_ticket` mod-reduce, `ticket_in_range` boundaries, 3-leaf Merkle with wrong-proof /
  tampered-leaf / empty-proof rejections). 27/27 unit tests green.
- ✅ **Integration + adversarial suite** (`tests/standalone-jackpot.ts`, **11/11**): commit →
  settle → winner claims the full pot; and every abuse reverts — claim-before-settle
  (`JackpotNotReady`), settle-before-epoch-elapsed (`EpochNotElapsed`), re-commit while busy
  (`JackpotBusy`), wrong Merkle proof (`BadProof`), non-winning holder (`NotWinner`), double claim.
  No regression: redeem 12/12, stake 11/11 still green.
- ⏳ **Randomness** = injected via `devnet-vrf` (default) for tests. **Switchboard VRF wiring**
  (`switchboard-vrf` feature) for production is the next on-chain step.
- ⏳ **Off-chain TWAB snapshotter** (transfer subscription → TWAB accumulator → Merkle root +
  published full snapshot) — reference implementation pending.
- ⏳ **Stateful fuzzer** for random commit/settle/claim sequences vs a reference model.

## Legal note (unchanged, louder)

A periodic **prize draw** with **real-stock prizes** is **both gambling- and securities-flavored** —
more regulated than the plain vault, not less. US geo-block + non-US entity + securities/gaming
counsel before any mainnet remain **mandatory**. Devnet-only until the audit *and* legal sign-off.
