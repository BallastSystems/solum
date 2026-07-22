# Solum Engine

The engine is an **off-chain trigger**, nothing more. It watches for accrued backing (withheld
transfer fees) and calls `add_backing` to route them through an allowlisted swap venue into an
allowlisted stock, deposited to the vault.

## What the engine can do
- Call `add_backing` (permissioned to the `engine` authority in `VaultConfig`).
- Choose the swap route/quote passed to that instruction.

## What the engine can NOT do — enforced on-chain, not here
- It cannot move a vault asset out. `add_backing` only ever *increases* vault balances; the
  program reloads the vault balance after the swap and requires it to have gone **up** by at
  least an oracle-derived min-out.
- It cannot redeem (that path is user-signed + burn-backed).
- It cannot change the stock allowlist, the swap-venue allowlist, or the fee rate (admin-only).
- It cannot send funds to an arbitrary address — the destination is constrained to the vault PDA.

**Therefore a fully compromised engine key cannot steal a single lamport of backing.** The
worst it can do is trigger a swap the program will reject unless it genuinely adds backing.
The engine holds no custody and no withdrawal power. This is the invariant that made the
difference in prior systems where an engine that *could* extract became the exploit.

## Isolation
Runs under its own identity/infra. No shared keys, no linkage to any other protocol or to the
operator's identity. Devnet-only until audited.

_Not yet implemented — this document fixes the contract the code must satisfy._
