# Solum host — deploy kit

An always-on host for the two Solum services. **Zero Magpie linkage**: its own account, its own
identity, the `github-ballast` SSH remote only. Never the Magpie Railway/GitHub/email.

## What runs here
- **`solum-bot`** — tracks every $SOLUM holder + the creator fees on `DWtw…6ZX8` in real time, runs
  the hourly snapshot → random xStock buy → Switchboard VRF draw, and writes `status.json` /
  `winners.json` (the live figures the site reads).
- **`solum-claim`** — the HTTP endpoint a winner hits on Claim; records the signature-verified claim
  and starts the 24h window. **Never sends funds** — the operator delivers manually.

## Recommended host
**Hetzner Cloud CX22** (2 vCPU / 4 GB, ~$5/mo, US region *Ashburn* for RPC proximity), Ubuntu 24.04.
Cheapest robust 24/7 box, fully isolated, full control. (DigitalOcean $6 / Vultr $6 are fine equivalents.)

## First-time setup
1. Create the VPS under a **Solum email** (not Magpie). Add the deploy SSH public key during creation.
2. Point DNS: `api.solum.work` **A** → the server IP.
3. SSH in and run:
   ```
   scp deploy/host-setup.sh root@<ip>:/root/ && ssh root@<ip> 'bash /root/host-setup.sh'
   ```
   (requires the `github-ballast` deploy key in the box's `~/.ssh` to clone the repo)
4. Copy the ops key up (host-only, 600): `scp .wallet/solum-ops.json root@<ip>:/opt/solum/secrets/`
5. `cp deploy/env.example /opt/solum/.env` and set `SOLUM_COIN_MINT` (the $SOLUM CA) at launch.
6. TLS: `apt install -y certbot python3-certbot-nginx && certbot --nginx -d api.solum.work`
7. Start the claim service now: `systemctl enable --now solum-claim`
8. **At launch**, after the real jackpot is initialized (which prints `SOLUM_POT_CUSTODY`), add it to
   `.env`, then `systemctl enable --now solum-bot`.

## Site wiring (one edit, at launch)
The static site currently fetches `status.json` / `winners.json` relative and posts claims to
`SOLUM_CLAIM_API`. Point all three at this host: `https://api.solum.work/status.json`,
`…/winners.json`, `…/claim`. (nginx already sets the CORS header for `solum.work`.)

## Operate
- Logs: `journalctl -u solum-bot -f` · `journalctl -u solum-claim -f`
- The operator's payout console (`automation/ops-dashboard.html`) reads `winners.json` — open it to
  see who to pay; deliver with the award CLI (`automation/award.ts`) within 24h.
- Redeploy code: `cd /opt/solum/app && git pull && <rebuild step from host-setup.sh> && systemctl restart solum-bot solum-claim`
