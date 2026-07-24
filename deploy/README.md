# Solum host — deploy kit

An always-on host for the two Solum services. **Zero Magpie linkage**: its own account, its own
identity, the `github-ballast` SSH remote only. Never the Magpie Railway/GitHub/email.

## What runs here
- **`solum-bot`** — tracks every $SOLUM holder + the creator fees on `DWtw…6ZX8` in real time, runs
  the hourly snapshot → random xStock buy → Switchboard VRF draw, and writes `status.json` /
  `winners.json` (the live figures the site reads).
- **`solum-claim`** — the HTTP endpoint a winner hits on Claim; records the signature-verified claim
  and starts the 24h window. **Never sends funds** — the operator delivers manually.

## Host — Oracle Cloud "Always Free" (chosen 2026-07-24, $0)
An **Ampere A1 (ARM64)** VM, Ubuntu 24.04, Always-Free eligible (1 OCPU / 6 GB is ample). $0 forever.
Node + both services run fine on ARM (the host only runs compiled JS — no on-chain program build here).
Oracle specifics vs a plain VPS:
- SSH user is **`ubuntu`** (not root): `ssh ubuntu@<ip>`; run setup with **`sudo bash host-setup.sh`**.
- **Two firewalls.** Open TCP **80 + 443** in the VCN **Security List** (cloud side) AND on the OS
  (host-setup.sh handles the OS iptables). SSH 22 is open by default.
- If "Out of host capacity" on A1, retry (or region-hop), or fall back to the AMD **E2.1.Micro** free shape.
(Hetzner CX22 ~$5/mo is the paid equivalent if you ever want simpler — the kit works on both.)

## First-time setup
1. Create the VPS under a **Solum email** (not Magpie). Add the deploy SSH public key during creation.
2. Point DNS: `api.solum.work` **A** → the server IP.
3. SSH in and run (Oracle user is `ubuntu`; use `sudo`):
   ```
   scp deploy/host-setup.sh ubuntu@<ip>:~/ && ssh ubuntu@<ip> 'sudo bash ~/host-setup.sh'
   ```
   (requires the `github-ballast` deploy key on the box to clone the repo)
4. Copy the ops key up (host-only, 600): `scp .wallet/solum-ops.json ubuntu@<ip>:/tmp/ && ssh ubuntu@<ip> 'sudo mv /tmp/solum-ops.json /opt/solum/secrets/ && sudo chmod 600 /opt/solum/secrets/solum-ops.json'`
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
