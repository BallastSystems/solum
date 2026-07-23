#!/usr/bin/env bash
# Deploy the Solum program to PUBLIC devnet. Uses ONLY explicit --url/--keypair — never the global
# solana CLI config (that points at mainnet). Set SOLUM_WALLET to your devnet deploy keypair.
#
#   SOLUM_WALLET=.wallet/your-devnet.json ./scripts/deploy-devnet.sh
set -euo pipefail

: "${SOLUM_WALLET:?set SOLUM_WALLET to your devnet deploy keypair path}"
: "${SOLUM_RPC:=https://api.devnet.solana.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROG_KP="$ROOT/target/deploy/solum-keypair.json"
SO="$ROOT/target/deploy/solum.so"
cd "$ROOT"

PUB="$(solana-keygen pubkey "$SOLUM_WALLET")"
BAL="$(solana balance "$SOLUM_WALLET" --url "$SOLUM_RPC" | awk '{print $1}')"
echo "deploy wallet : $PUB"
echo "devnet balance: $BAL SOL"
if awk "BEGIN{exit !($BAL < 4)}"; then
  echo ""
  echo "!! Need >= 4 SOL to deploy a ~530KB program. Fund the wallet, then re-run:"
  echo "     • https://faucet.solana.com  (paste $PUB, select devnet), or"
  echo "     • solana airdrop 2 $SOLUM_WALLET --url $SOLUM_RPC   (retry when the rate limit clears)"
  exit 1
fi

echo "== building (default features = devnet-vrf; switchboard-vrf is the production follow-on) =="
anchor build >/dev/null

echo "== deploying to devnet =="
solana program deploy "$SO" --url "$SOLUM_RPC" --keypair "$SOLUM_WALLET" --program-id "$PROG_KP"

PID="$(solana-keygen pubkey "$PROG_KP")"
echo ""
echo "== deployed =="
echo "  program id : $PID"
echo "  explorer   : https://explorer.solana.com/address/$PID?cluster=devnet"
solana program show "$PID" --url "$SOLUM_RPC" 2>/dev/null | grep -iE "Program Id|Authority|Data Length|Balance" || true
echo ""
echo "Next: initialize the coin + 5 stock mints + jackpot with:"
echo "  ANCHOR_PROVIDER_URL=$SOLUM_RPC ANCHOR_WALLET=$SOLUM_WALLET \\"
echo "    npx tsx automation/init-devnet.ts   # writes automation/devnet-addresses.json"
