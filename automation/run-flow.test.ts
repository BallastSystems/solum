// Integration test: drives ONE full cycle of the NEW run.ts orchestration against the local validator
// and asserts the published status.json / winners.json / fee-state. The buy is a no-op on devnet (no
// pump.fun), so this verifies the FLOW end to end: collecting → snapshot → prize advertised → fixed
// countdown → VRF draw → winner recorded (claim-pending) → real all-time fee figure published.

import * as anchor from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, createAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runForever } from "./run";

const results: { name: string; ok: boolean }[] = [];
const check = (n: string, ok: boolean) => { results.push({ name: n, ok }); console.log((ok ? "  PASS  " : "  FAIL  ") + n); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const ops = (provider.wallet as anchor.Wallet).payer;
  const rpc = (conn as any)._rpcEndpoint as string;
  if (!/127\.0\.0\.1|localhost/.test(rpc)) throw new Error("run-flow.test: local validator only");
  const idl = JSON.parse(fs.readFileSync(path.resolve("target/idl/solum.json"), "utf8"));
  const prog = new anchor.Program(idl as anchor.Idl, provider);
  const CP = TOKEN_PROGRAM_ID, RP = TOKEN_2022_PROGRAM_ID, DEC = 6;

  console.log("\n=== solum :: run.ts full-cycle flow (local validator) ===");

  // coin + 5 stock mints + ops accounts + jackpot
  const coin = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, CP);
  const stocks: Record<string, { mint: PublicKey; opsAccount: PublicKey; tokenProgram: PublicKey }> = {};
  for (const s of ["AAPLx", "NVDAx", "TSLAx", "COINx", "MSTRx"]) {
    const m = await createMint(conn, ops, ops.publicKey, null, DEC, undefined, undefined, RP);
    const acct = await createAssociatedTokenAccount(conn, ops, m, ops.publicKey, {}, RP);
    stocks[s] = { mint: m, opsAccount: acct, tokenProgram: RP };
  }
  const enc = (x: string) => Buffer.from(x);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coin.toBuffer(), ops.publicKey.toBuffer()], prog.programId);
  const [jAuth] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const prizeMint = stocks["AAPLx"].mint;
  const pot = await createAssociatedTokenAccount(conn, ops, prizeMint, jAuth, {}, RP, undefined, true);
  await prog.methods.initJackpot(new anchor.BN(1)).accounts({
    admin: ops.publicKey, coinMint: coin, prizeMint, snapshotter: ops.publicKey,
    jackpot, jackpotAuthority: jAuth, potCustody: pot, systemProgram: SystemProgram.programId,
  }).rpc();

  // 3 holders holding $SOLUM (so the snapshot has real entries + a real winner)
  for (const whole of [500, 300, 200]) {
    const kp = Keypair.generate();
    const ata = await createAssociatedTokenAccount(conn, ops, coin, kp.publicKey, {}, CP);
    await mintTo(conn, ops, coin, ata, ops, whole * 1e6, [], undefined, CP);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "solum-flow-"));
  const statusFile = path.join(dir, "status.json"), winnersFile = path.join(dir, "winners.json"), feeStateFile = path.join(dir, "fee-state.json");
  const countdownSec = 3;
  const cfg: any = {
    rpc, coinMint: coin, coinDecimals: DEC, vrf: "devnet",
    stocks, rotation: ["AAPLx", "NVDAx", "TSLAx", "COINx", "MSTRx"], ops, prog,
    refs: { jackpot, jackpotAuthority: jAuth, prizeMint, potCustody: pot, prizeTokenProgram: RP },
    statusFile, winnersFile, snapshotDir: path.join(dir, "snaps"), feeStateFile,
    epochLenSec: 1, snapMinSec: 3, snapMaxSec: 4, countdownSec, feePollSec: 1, solPriceUsd: 150,
  };

  // fire the loop; we assert on its published files, then exit (which stops it)
  runForever(cfg).catch(() => { /* loop keeps the process alive until we exit */ });

  let st: any = null, sawCollecting = false, sawSnap = false, maxWinners = 0;
  const winnersLen = () => { try { return JSON.parse(fs.readFileSync(winnersFile, "utf8")).length; } catch { return 0; } };
  for (let i = 0; i < 100; i++) {
    try { st = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch { /* not written yet */ }
    if (st) {
      if (st.phase === "collecting") sawCollecting = true;
      if (st.phase === "snapshot_taken" && !sawSnap) {
        sawSnap = true;
        check("snapshot_taken advertises a prize (a stock is chosen)", !!(st.prize && st.prize.stock));
        check("prize stock is one of the five", ["AAPLx", "NVDAx", "TSLAx", "COINx", "MSTRx"].indexOf(st.prize.stock) >= 0);
        check("drawAt == snapshot + fixed countdown (5-min in prod; countdownSec here)",
          Math.abs((Date.parse(st.drawAt) - Date.parse(st.snapshotAt)) / 1000 - countdownSec) <= 2);
        check("holders were sealed in the snapshot", st.holders >= 3);
      }
    }
    maxWinners = Math.max(maxWinners, winnersLen());
    if (maxWinners >= 3) break; // three consecutive draws → the close_epoch reset works cycle-over-cycle
    await sleep(1000);
  }

  check("passed through the collecting phase", sawCollecting);
  check("saw the snapshot_taken announcement", sawSnap);
  check("publishes a real all-time fee figure (feesLifetimeUsd is numeric)", !!st && typeof st.feesLifetimeUsd === "number");
  check("MULTIPLE consecutive draws succeed (>=3 winners → close_epoch reset works, no JackpotBusy)", maxWinners >= 3);
  const wOk = (() => { try { const w = JSON.parse(fs.readFileSync(winnersFile, "utf8")); return w.length > 0 && w[0].claimed === false && !!w[0].stock && typeof w[0].prizeBaseUnits === "string"; } catch { return false; } })();
  check("winners are recorded claim-pending, with stock + prizeBaseUnits", wOk);
  console.log(`  (observed ${maxWinners} winners across the run)`);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
