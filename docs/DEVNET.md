# Public-devnet deployment runbook

Everything to take Solum from the local validator to public Solana **devnet**. All commands use
explicit `--url`/`--keypair` — **never** the global `solana` CLI config (that points at mainnet).

## 0. Prerequisites

- The deploy keypair (this repo's `target/deploy/solum-keypair.json` → program id
  `A8LrxCF86mcBzUZSFd55g6xD96T1xzmkHwPQTCQKcBcU`).
- A devnet **fee/authority wallet** with ≥ 4 SOL. Export its path once:
  ```
  export SOLUM_WALLET=.wallet/your-devnet.json
  export SOLUM_RPC=https://api.devnet.solana.com
  ```

## 1. Fund the wallet (the only manual gate)

A ~530 KB program costs ~4 SOL to deploy. Devnet SOL is free but rate-limited:
- **Web:** https://faucet.solana.com — paste `solana-keygen pubkey $SOLUM_WALLET`, pick devnet.
- **CLI:** `solana airdrop 2 $SOLUM_WALLET --url $SOLUM_RPC` (retry until you have ≥ 4 SOL).

## 2. Deploy the program

```
./scripts/deploy-devnet.sh
```

Guards on the balance, builds (default `devnet-vrf` features), deploys, and prints the explorer link.

## 3. Initialize coin + 5 stock mints + jackpot

```
ANCHOR_PROVIDER_URL=$SOLUM_RPC ANCHOR_WALLET=$SOLUM_WALLET \
  npx tsc automation/init-devnet.ts --outDir target/autobuild --module commonjs --target es2020 \
    --esModuleInterop --resolveJsonModule --skipLibCheck --moduleResolution node \
  && node target/autobuild/init-devnet.js
```

Writes `automation/devnet-addresses.json` (coin, the 5 stock mints, jackpot, pot custody).

## 4. Run the draw bot against devnet

Populate the bot env from `devnet-addresses.json`, then:
```
SOLUM_RPC=$SOLUM_RPC SOLUM_OPS_KEY=$SOLUM_WALLET \
SOLUM_COIN_MINT=<coinMint> SOLUM_ADMIN=<admin> SOLUM_STOCK_MINT=<AAPLx> \
SOLUM_OPS_STOCK_ACCT=<ops AAPLx ATA> SOLUM_POT_CUSTODY=<potCustody> \
SOLUM_STOCK_PROGRAM=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  node target/autobuild/run.js
```
It publishes `status.json` / `winners.json`; point the site's fetch at that host to go live.

## Two follow-ons (not blockers for a devnet demo)

- **Switchboard VRF (production randomness).** The default build settles from snapshotter-injected
  randomness (fine for a devnet demo, but the snapshotter controls it). For real randomness, build
  with `--features switchboard-vrf`, create a Switchboard On-Demand **queue + randomness account** on
  devnet, and use `request_draw` → `settle_draw`. The code is wired (`programs/solum/src/lib.rs`); the
  remaining work is the Switchboard devnet setup + a live-oracle test.
- **5-stock rotation on-chain.** The jackpot binds **one** prize mint per epoch, so true hourly
  rotation across the five needs a small admin `set_prize_mint` instruction (swap the prize mint +
  pot custody while the jackpot is OPEN, between epochs). The site + bot already model the rotation;
  this closes it on-chain.

## Guardrails

- Solum's cluster is **devnet** via explicit flags + the isolated wallet. The global CLI config is
  mainnet + a different key — never used here.
- Solum GitHub is the isolated **SSH key** only (the `github-ballast` alias). The `gh` CLI on this machine is a different
  identity — never use it for Solum.
