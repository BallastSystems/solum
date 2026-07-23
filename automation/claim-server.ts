// Claim service — a tiny HTTP endpoint the site calls when a winner clicks Claim. It records the
// (signature-verified) claim via registerClaim() and starts the 24h delivery window. It does NOT
// send funds — the operator delivers manually with the award CLI (automation/award.ts). It still
// loads the ops wallet (to know the custody pubkey / share config); the key never leaves the env.
//
//   SOLUM_RPC=https://api.mainnet-beta.solana.com \
//   SOLUM_OPS_KEY=/secure/ops-wallet.json \        # SECRET — the custody wallet keypair
//   SOLUM_STOCK_MINT=<mint> SOLUM_OPS_STOCK_ACCT=<ops stock ATA> \
//   SOLUM_STOCK_PROGRAM=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
//   SOLUM_WINNERS_FILE=automation/winners.json SOLUM_SITE_ORIGIN=https://solum.work PORT=8787 \
//     node target/build/claim-server.js

import * as http from "http";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { registerClaim, ClaimConfig, ClaimRequest } from "./claim";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

function loadKey(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
}
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function main() {
  const cfg: ClaimConfig = {
    conn: new Connection(process.env.SOLUM_RPC || "http://127.0.0.1:8899", "confirmed"),
    ops: loadKey(need("SOLUM_OPS_KEY")),
    stockMint: new PublicKey(need("SOLUM_STOCK_MINT")),
    stockProgram: new PublicKey(process.env.SOLUM_STOCK_PROGRAM || TOKEN_2022),
    opsStockAccount: new PublicKey(need("SOLUM_OPS_STOCK_ACCT")),
    winnersFile: process.env.SOLUM_WINNERS_FILE || "automation/winners.json",
  };
  const origin = process.env.SOLUM_SITE_ORIGIN || "*";
  const port = Number(process.env.PORT || 8787);

  const send = (rs: http.ServerResponse, code: number, body: unknown) => {
    rs.writeHead(code, { "Content-Type": "application/json" });
    rs.end(JSON.stringify(body));
  };

  const server = http.createServer((rq, rs) => {
    rs.setHeader("Access-Control-Allow-Origin", origin);
    rs.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    rs.setHeader("Access-Control-Allow-Headers", "Content-Type");
    const path = (rq.url || "").split("?")[0];
    if (rq.method === "OPTIONS") return send(rs, 204, {});
    if (rq.method === "GET" && path === "/health") return send(rs, 200, { ok: true });
    if (rq.method !== "POST" || path !== "/claim") return send(rs, 404, { ok: false, reason: "not found" });

    let body = "";
    rq.on("data", (c) => {
      body += c;
      if (body.length > 8192) rq.destroy(); // cap request size
    });
    rq.on("end", async () => {
      let req: ClaimRequest;
      try {
        req = JSON.parse(body);
      } catch {
        return send(rs, 400, { ok: false, reason: "invalid JSON" });
      }
      try {
        const out = registerClaim(cfg, req);
        send(rs, out.ok ? 200 : 400, out);
        console.log(`[claim] epoch ${req?.epoch} winner ${req?.winner} -> ${out.ok ? "CLAIM RECORDED (deliver by " + (out as any).awardWithin + ")" : "REJECT " + (out as any).reason}`);
      } catch (e: any) {
        send(rs, 500, { ok: false, reason: "server error" });
        console.error("[claim] error:", e?.message || e);
      }
    });
  });

  server.listen(port, () => console.log(`[claim] fulfillment service on :${port} · custody wallet ${cfg.ops.publicKey.toBase58()}`));
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
