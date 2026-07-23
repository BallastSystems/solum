# Operator Runbook

How to give your pump.fun coin a redeemable floor and keep 100% of your creator fees.
Everything here either configures the vault or **adds** backing — nothing can remove value.

> Devnet only for now. `export ANCHOR_PROVIDER_URL=<rpc>` and
> `export ANCHOR_WALLET=<your-keypair.json>` first. Build the CLI once: `npm run build:cli`.
> Then run commands as `npm run solum -- <command> …`.

## 1. Launch your coin on pump.fun
Launch normally. It's a plain SPL coin; you remain the creator and keep **100% of creator
fees** — Solum never touches them. Copy the coin's **mint address**.

## 2. Open a vault for the coin
Allowlist the tokenized stocks that may ever back it (comma-separated mints):

```sh
npm run solum -- init-vault <COIN_MINT> <AAPLx_MINT>,<NVDAx_MINT>,<TSLAx_MINT>
```

You become the vault admin. The vault is a program-derived account — **no private key for it
exists**, so no one (including you) can withdraw from it. Holders can only ever redeem.

## 3. Publish a price for each stock
Used only as a *floor* when swapping SOL→stock via `add_backing`; direct deposits don't need
it, but the dashboard uses it to value the vault. Price is whole quote units per whole share.

```sh
npm run solum -- set-price <COIN_MINT> <AAPLx_MINT> 150      # 1 AAPLx = $150
```

*(Devnet uses an admin-published price. Production reads a Pyth feed — same guard, different
source.)*

## 4. Fund the floor — buybacks
Buy the tokenized stock in your own wallet (Jupiter, an exchange, wherever), then deposit it.
Every deposit raises the floor and emits an on-chain event, so each buyback is publicly
verifiable.

```sh
npm run solum -- deposit <COIN_MINT> <AAPLx_MINT> 12        # deposit 12 shares
```

Do this whenever you want to raise the floor. There is no schedule and no obligation — but
every deposit is visible, so consistency is the reputation.

## 5. Verify — anyone can
```sh
npm run solum -- reserves <COIN_MINT>
```
Prints supply, each stock's value, total reserves, and the redeemable floor per token — all
read straight from the chain. This is the same computation the dashboard shows.

## What holders do
A holder redeems by burning their coins for a pro-rata slice of every stock in the vault
(front-end calls the `redeem` instruction). Burning first, paid out in exact proportion — the
floor is preserved for everyone who stays.

## Optional: swap SOL→stock atomically (`add_backing`)
Instead of buying stock yourself, you can route SOL through an allowlisted venue and have the
program deposit the stock, rejecting the transaction unless the vault gains at least the
oracle-priced amount (minus your slippage cap). This is the `add_backing` path; it needs a
venue adapter and a live price. Direct `deposit` (step 4) is the simplest buyback.
