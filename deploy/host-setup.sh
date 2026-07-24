#!/usr/bin/env bash
# One-time provisioning for the Solum host (Ubuntu 24.04). Idempotent — safe to re-run.
# Run as root on a FRESH VPS:  bash host-setup.sh
# Installs Node 20, builds the app, installs systemd services + nginx, and (optionally) TLS.
set -euo pipefail

APP=/opt/solum/app
DATA=/var/www/solum-data
REPO="git@github-ballast:BallastSystems/solum.git"   # Solum identity only — never a remote tied to another project

echo "== packages =="
apt-get update -y
apt-get install -y curl git nginx ufw
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "== firewall (open 80/443 — works on Hetzner ufw AND Oracle's default iptables) =="
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH || true; ufw allow 'Nginx Full' || true; ufw --force enable || true
fi
# Oracle Cloud Ubuntu images ship a restrictive iptables INPUT chain (a REJECT catch-all). Insert
# ACCEPT for 80/443 ABOVE it, then persist. (You must ALSO open 80/443 in the VCN Security List.)
if iptables -C INPUT -j REJECT --reject-with icmp-host-prohibited 2>/dev/null; then
  iptables -I INPUT -p tcp --dport 80  -j ACCEPT
  iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null 2>&1 || true
  netfilter-persistent save 2>/dev/null || true
fi

echo "== directories =="
mkdir -p /opt/solum/secrets /opt/solum/state "$DATA/snapshots"
chmod 700 /opt/solum/secrets

echo "== fetch + build the app (Solum SSH identity must be configured in ~/.ssh/config) =="
if [ ! -d "$APP/.git" ]; then git clone "$REPO" "$APP"; else git -C "$APP" pull --ff-only; fi
cd "$APP"
npm ci
# build the two service entrypoints to plain JS
npx tsc automation/run.ts automation/claim-server.ts --outDir /opt/solum/app/build \
  --rootDir . --module commonjs --target es2020 --esModuleInterop --resolveJsonModule \
  --skipLibCheck --moduleResolution node

echo "== nginx + systemd =="
cp "$APP/deploy/nginx-solum.conf" /etc/nginx/sites-available/solum
ln -sf /etc/nginx/sites-available/solum /etc/nginx/sites-enabled/solum
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
cp "$APP/deploy/solum-bot.service" "$APP/deploy/solum-claim.service" /etc/systemd/system/
systemctl daemon-reload

echo
echo "NEXT (manual, once):"
echo "  1. Put the ops key at /opt/solum/secrets/solum-ops.json (scp; chmod 600). It must derive to DWtw…6ZX8."
echo "  2. cp $APP/deploy/env.example /opt/solum/.env  and set SOLUM_COIN_MINT (+ SOLUM_POT_CUSTODY after init)."
echo "  3. Point DNS: api.solum.work  A → this server's IP."
echo "  4. TLS:  certbot --nginx -d api.solum.work   (apt-get install -y certbot python3-certbot-nginx)"
echo "  5. Start:  systemctl enable --now solum-claim   (bot is started AT launch, after the jackpot is initialized)"
echo "Done. Services are installed but not started until launch."
