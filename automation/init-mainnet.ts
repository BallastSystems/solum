// Initialize the REAL Solum jackpot on mainnet for the live $SOLUM coin. Uses the EXISTING coin +
// prize mint (nothing is created except the pot-custody ATA). Idempotent-ish: if the jackpot PDA
// already exists it just prints the refs. Run with the ops key:
//   SOLUM_RPC=https://api.mainnet-beta.solana.com SOLUM_OPS_KEY=.wallet/solum-ops.json \
//   SOLUM_IDL=target/idl/solum-prod.json SOLUM_COIN_MINT=<$SOLUM> SOLUM_PRIZE_MINT=<AAPLx> \
//   SOLUM_EPOCH_LEN=60 node ... init-mainnet.js
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";

async function main() {
  const rpc = process.env.SOLUM_RPC || "https://api.mainnet-beta.solana.com";
  if (!/mainnet/.test(rpc)) throw new Error("mainnet only");
  const ops = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.SOLUM_OPS_KEY!, "utf8"))));
  const conn = new Connection(rpc, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(ops), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(process.env.SOLUM_IDL || "target/idl/solum-prod.json", "utf8"));
  const prog = new anchor.Program(idl, provider);

  const coinMint = new PublicKey(process.env.SOLUM_COIN_MINT!);
  const prizeMint = new PublicKey(process.env.SOLUM_PRIZE_MINT || "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"); // AAPLx (Token-2022)
  const epochLen = Number(process.env.SOLUM_EPOCH_LEN || 60);
  const admin = ops.publicKey; // = DWtw, snapshotter + jackpot-PDA seed
  const enc = (s: string) => Buffer.from(s);
  const [jackpot] = PublicKey.findProgramAddressSync([enc("jackpot"), coinMint.toBuffer(), admin.toBuffer()], prog.programId);
  const [jackpotAuthority] = PublicKey.findProgramAddressSync([enc("jackpotauth"), jackpot.toBuffer()], prog.programId);
  const potCustody = getAssociatedTokenAddressSync(prizeMint, jackpotAuthority, true, TOKEN_2022_PROGRAM_ID);

  console.log(`coin (SOLUM): ${coinMint.toBase58()}`);
  console.log(`prize (init): ${prizeMint.toBase58()}`);
  console.log(`jackpot     : ${jackpot.toBase58()}`);
  console.log(`jAuthority  : ${jackpotAuthority.toBase58()}`);
  console.log(`potCustody  : ${potCustody.toBase58()}`);

  const existing = await conn.getAccountInfo(jackpot);
  if (existing) { console.log("\n✅ jackpot already initialized — refs above."); printEnv(); return; }

  // create the pot custody ATA (jackpotAuthority is a PDA → off-curve), then init the jackpot
  const tx = new Transaction();
  if (!(await conn.getAccountInfo(potCustody)))
    tx.add(createAssociatedTokenAccountInstruction(ops.publicKey, potCustody, jackpotAuthority, prizeMint, TOKEN_2022_PROGRAM_ID));
  const ix = await prog.methods.initJackpot(new anchor.BN(epochLen)).accounts({
    admin, coinMint, prizeMint, snapshotter: admin,
    jackpot, jackpotAuthority, potCustody, systemProgram: SystemProgram.programId,
  }).instruction();
  tx.add(ix);
  const sig = await provider.sendAndConfirm(tx, []);
  console.log(`\n✅ jackpot initialized (epoch_len=${epochLen}s) · ${sig}`);
  printEnv();

  function printEnv() {
    console.log(`\n--- add to /opt/solum/.env ---\nSOLUM_POT_CUSTODY=${potCustody.toBase58()}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
