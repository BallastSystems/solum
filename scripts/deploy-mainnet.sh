#!/usr/bin/env bash
# Deploy the Solum program to MAINNET-BETA. Production build only (pyth-oracle + switchboard-vrf).
# Uses ONLY explicit --url/--keypair — never the global solana CLI config.
#
# ⛔ HARD GATES — do NOT run this until BOTH are true:
#   1. The on-chain program has passed a security AUDIT (findings fixed + published).
#   2. Legal is cleared: counsel sign-off, non-US entity, US geo-block, terms/disclaimers.
# This spends REAL SOL and ships an immutable-by-default program that will custody value.
#
#   SOLUM_WALLET=/secure/mainnet-deploy.json SOLUM_CONFIRM=I_HAVE_AUDIT_AND_LEGAL \
#     ./scripts/deploy-mainnet.sh
set -euo pipefail

: "${SOLUM_WALLET:?set SOLUM_WALLET to your mainnet deploy keypair path (SECRET, never in git)}"
: "${SOLUM_RPC:=https://api.mainnet-beta.solana.com}"
: "${SOLUM_CONFIRM:?refusing to deploy: set SOLUM_CONFIRM=I_HAVE_AUDIT_AND_LEGAL to confirm the audit + legal gates are cleared}"
if [ "$SOLUM_CONFIRM" != "I_HAVE_AUDIT_AND_LEGAL" ]; then
  echo "!! SOLUM_CONFIRM must equal I_HAVE_AUDIT_AND_LEGAL — audit + legal are hard gates. Aborting."
  exit 1
fi
case "$SOLUM_RPC" in
  *devnet*|*testnet*|*localhost*|*127.0.0.1*)
    echo "!! SOLUM_RPC ($SOLUM_RPC) is not mainnet. Use deploy-devnet.sh for non-mainnet."; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROG_KP="$ROOT/target/deploy/solum-keypair.json"
SO="$ROOT/target/deploy/solum.so"
cd "$ROOT"

PUB="$(solana-keygen pubkey "$SOLUM_WALLET")"
BAL="$(solana balance "$SOLUM_WALLET" --url "$SOLUM_RPC" | awk '{print $1}')"
echo "network       : MAINNET-BETA ($SOLUM_RPC)"
echo "deploy wallet : $PUB"
echo "balance       : $BAL SOL"
# ~530KB program ≈ ~4 SOL rent; keep headroom for tx fees.
if awk "BEGIN{exit !($BAL < 5)}"; then
  echo "!! Need >= 5 SOL on the deploy wallet (program rent + fees). Fund it, then re-run."; exit 1
fi

echo "== building PRODUCTION program (pyth-oracle + switchboard-vrf) =="
# NOTE: switchboard-vrf needs platform-tools >= v1.50 (rustc 1.84; base64ct wants 1.81), and the
# Cargo.lock pins tempfile=3.12.0 so switchboard-protos doesn't drag getrandom 0.4.3 (edition2024,
# which the SBF toolchain can't parse). Default tools (v1.43/rustc 1.79) will NOT build this.
cargo build-sbf --manifest-path programs/solum/Cargo.toml \
  --no-default-features --features "pyth-oracle switchboard-vrf" --tools-version v1.50

echo ""
echo ">> About to deploy to MAINNET from $PUB (real SOL). Ctrl-C now to abort."
for i in 5 4 3 2 1; do printf "   deploying in %ss...\r" "$i"; sleep 1; done
echo ""

solana program deploy "$SO" --url "$SOLUM_RPC" --keypair "$SOLUM_WALLET" --program-id "$PROG_KP"

PID="$(solana-keygen pubkey "$PROG_KP")"
echo ""
echo "== deployed to mainnet =="
echo "  program id : $PID"
echo "  explorer   : https://explorer.solana.com/address/$PID"
solana program show "$PID" --url "$SOLUM_RPC" 2>/dev/null | grep -iE "Program Id|Authority|Data Length|Balance" || true
echo ""
echo "Next:"
echo "  1. Initialize coin + 5 stock mints + jackpot (init script, mainnet env)."
echo "  2. Set up the Switchboard On-Demand queue + randomness account (production draws)."
echo "  3. Consider revoking/locking the program upgrade authority per your governance plan."
