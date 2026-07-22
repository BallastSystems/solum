// Live proof-of-reserves dashboard server. Serves the dashboard page and a read-only
// /api/reserves?mint=<coin> endpoint backed by computeReserves(). Same-origin fetch, so the
// page shows real on-chain numbers (an Artifact can't — its CSP blocks RPC).
//   ANCHOR_PROVIDER_URL=<rpc> PORT=4000 npm run dashboard

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { computeReserves } from "./reserves";

const PORT = parseInt(process.env.PORT || "4000");
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" });
const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
const program = new anchor.Program(idl as anchor.Idl, provider);
const html = fs.readFileSync(path.resolve("app/dashboard.html"), "utf8");

http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname === "/api/reserves") {
    try {
      const mint = new PublicKey(url.searchParams.get("mint") || "");
      const admin = new PublicKey(url.searchParams.get("admin") || "");
      const r = await computeReserves(conn, program, mint, admin);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(r));
    } catch (e: any) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}).listen(PORT, () => console.log(`Solum dashboard → http://localhost:${PORT}   (RPC ${RPC})`));
