# Testing

Devnet-only project; all tests run against a local validator you control.

## Redeem floor — adversarial suite

`tests/standalone-redeem.ts` attacks the redeem path and asserts each attack reverts, then
asserts the honest path pays exact pro-rata and preserves the floor. It is a standalone
runner (no mocha) because Node ≥26 breaks mocha's bundled `yargs`. `tests/redeem.ts` is the
equivalent mocha suite for `anchor test` under an LTS Node.

### Run it

```sh
# 1. Start a local validator (fresh ledger)
solana-test-validator --reset --quiet &

# 2. Fund the provider wallet (deploy costs ~2 SOL)
solana airdrop 100 $(solana-keygen pubkey .wallet/ballast-devnet.json) -u http://127.0.0.1:8899

# 3. Build + deploy to it
anchor build
anchor deploy --provider.cluster localnet

# 4. Run the adversarial suite
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=.wallet/ballast-devnet.json \
npm run test:standalone
```

Expected: `9/9 passed`.

### What it proves
- `BadVaultOwner` — an attacker-supplied account cannot stand in as the vault source.
- `AmountExceedsSupply`, `StockMismatch`, `ZeroAmount`, `Paused` — all revert.
- Honest redeem: exact `amount * vault_balance / supply` per stock, exact burn, floor preserved.

## Toolchain note
`anchor build` uses Solana's SBF rustc (1.79). Several transitive crates were pinned down in
`Cargo.lock` to build on it — do not run `cargo update` unpinned or the edition2024 crates
return. See the pinned versions in `Cargo.lock` (blake3, proc-macro-crate, indexmap, zeroize,
zeroize_derive, unicode-segmentation).
