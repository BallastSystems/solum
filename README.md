# Solum

**Hold $SOLUM, win real stock.** Solum is a memecoin whose creator fees are used to buy real
tokenized stock — Apple, NVIDIA, Tesla, Coinbase, MicroStrategy — and raffle it to holders every
hour. The more $SOLUM you hold, the better your odds. You never stake, lock, or risk your coins.

Tokenized stock is issued by our partner **[Sunrise Financial](https://sunrise.xyz)**.

## How it works

1. **Hold $SOLUM.** Buy and hold like any Solana memecoin (launched on pump.fun). No accounts, no lock-up.
2. **Fees buy stock, every hour.** The coin's creator fees automatically buy real tokenized stock
   into an on-chain pot. More trading volume → more fees → a bigger pot.
3. **A holder wins.** At a random, unannounced time each hour a snapshot of all holders is taken;
   a Switchboard VRF then draws a winner — weighted by holdings — and the whole pot is paid to them
   on-chain. You keep your coins either way.

## Fair by design

- **Un-gameable odds.** Your odds are your *average* $SOLUM balance over the hour (TWAB), and both
  the snapshot and the draw fire at random, unannounced times — so a last-second buy is worthless
  and you can't time either event.
- **Randomness you can't rig.** The winning ticket comes from a Switchboard VRF, oracle-revealed
  and impossible to predict or grind.
- **The pot can only reach the winner.** The pot is a program-derived account with no private key
  and no withdraw / sweep instruction. The only outflow is a payout to the holder the VRF drew,
  proven by their Merkle ticket and constrained on-chain to their own wallet.
- **Check it yourself.** Every draw publishes its full snapshot; `automation/verify-draw.ts`
  re-derives the Merkle root and confirms the winner from public data.

## Partners

- **[Sunrise Financial](https://sunrise.xyz)** — tokenized-stock issuance. The real Apple, NVIDIA,
  Tesla, Coinbase, and MicroStrategy shares that fund the draws are issued through Sunrise.

## Repository layout

- `programs/solum/` — the on-chain program: the raffle (`init_jackpot`, `commit_epoch`,
  `request_draw` / `settle_draw`, `claim_prize`), the redeemable-stock vault (`redeem`,
  `add_backing`), staking, and the Pyth / Switchboard oracle paths.
- `programs/mock-venue/` — TEST-ONLY swap venue for exercising `add_backing`.
- `automation/` — the off-chain draw bot: TWAB snapshotter, Merkle builder, draw orchestrator,
  creator-fee → stock funding, and the hourly scheduler with random snapshot / draw times. Publishes
  `status.json` and `winners.json` for the site, plus the independent draw verifier.
- `docs/` — mechanism, security architecture, the jackpot spec (`JACKPOT.md`), and the runbook.
- `tests/` — program integration + adversarial suites and the invariant fuzzer.

## Tests

- **Rust unit** (security-critical math): `cargo test -p solum --features no-entrypoint`.
- **Program integration / adversarial + invariant fuzz** — `tests/`: vault redeem, backing,
  staking, jackpot, and a ~9,800-op invariant fuzzer.
- **Off-chain** — `automation/`: `twab.test.ts`, `cycle.test.ts` (full draw cycle),
  `verify-draw.test.ts`, and `stress-500.ts` (500 fee-funded draws + a fairness report).

## Status

**Devnet only, pre-audit.** Independent review by OtterSec is in progress — see
[github.com/BallastSystems/solum-audit](https://github.com/BallastSystems/solum-audit). No mainnet
and no real assets until the audit *and* legal review are complete. A real-stock prize draw is both
gambling- and securities-flavored; a US geo-block, a non-US entity, and securities/gaming counsel
are prerequisites.

## Toolchain

Anchor 0.31.1 · Solana 2.1.x · devnet.
