//! Solum — non-custodial redeemable-floor vault program.
//!
//! # The one invariant
//! No instruction moves a vault asset anywhere except:
//!   1. a holder redeeming their OWN pro-rata share (user-signed, backed by a token burn), or
//!   2. a swap that ADDS backing into the vault (see the `add_backing` increment).
//!
//! There is deliberately NO `withdraw`, `admin_withdraw`, `emergency_withdraw`, or
//! `sweep_to(addr)` instruction. The `engine` and `admin` authorities can never move a
//! vault asset out — even with a fully compromised key. Extraction is not gated; it does
//! not exist as a code path. `paused` halts new redemptions/backing; it can never move funds.
//!
//! Devnet-only until audited (Sec3 / OtterSec tier) + legally reviewed. See docs/.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    keccak,
    program::invoke_signed,
};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{
    self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};
#[cfg(feature = "switchboard-vrf")]
use switchboard_on_demand::accounts::RandomnessAccountData;

declare_id!("A8LrxCF86mcBzUZSFd55g6xD96T1xzmkHwPQTCQKcBcU");

/// Max stocks a single vault may back into. Fixed-size (no realloc) for deterministic rent
/// and a bounded redeem loop. Raising this is a program upgrade, not a runtime action.
pub const MAX_STOCKS: usize = 8;

/// Hard ceiling on the backing fee, in basis points (3%). `admin` can set the rate anywhere
/// in [0, MAX_FEE_BPS]; it can never exceed this, by construction.
pub const MAX_FEE_BPS: u16 = 300;

/// Hard ceiling on the slippage tolerance for backing swaps (5%). The vault will reject any
/// swap that delivers less than `oracle_fair_out * (1 - max_slippage)`.
pub const MAX_SLIPPAGE_BPS: u16 = 500;

/// Oracle price is rejected if older than this many slots (~2 min at 400ms/slot). devnet-oracle.
pub const MAX_PRICE_STALENESS_SLOTS: u64 = 300;
/// Pyth price is rejected if its publish time is older than this many seconds. pyth-oracle.
pub const MAX_PRICE_AGE_SECONDS: u64 = 60;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PRICE_SEED: &[u8] = b"price";
/// Per-vault, per-stock Pyth feed-id binding PDA (pyth-oracle feature).
pub const ORACLE_SEED: &[u8] = b"oracle";
/// Stake-to-earn: pool PDA `[STAKE_SEED, coin_mint, admin]`; stake-authority PDA (owns the staked-
/// coin custody + reward vault) `[STAKE_AUTH_SEED, pool]`; per-user stake PDA `[STAKE_ACCT_SEED, pool, owner]`.
pub const STAKE_SEED: &[u8] = b"stakepool";
pub const STAKE_AUTH_SEED: &[u8] = b"stakeauth";
pub const STAKE_ACCT_SEED: &[u8] = b"stakeacct";
/// No-loss jackpot: state PDA `[JACKPOT_SEED, coin_mint, admin]`; authority PDA (owns the prize
/// pot custody, no private key) `[JACKPOT_AUTH_SEED, jackpot]`. See docs/JACKPOT.md.
pub const JACKPOT_SEED: &[u8] = b"jackpot";
pub const JACKPOT_AUTH_SEED: &[u8] = b"jackpotauth";
/// Jackpot draw phases.
pub const PHASE_OPEN: u8 = 0; // awaiting the snapshotter to commit an epoch root
pub const PHASE_COMMITTED: u8 = 1; // root committed; draw settles once the epoch elapses
pub const PHASE_SETTLED: u8 = 2; // winning ticket fixed; the winner may claim
pub const PHASE_REQUESTED: u8 = 3; // [switchboard-vrf] randomness bound; awaiting oracle reveal
/// Authority (a program PDA) set as BOTH the Token-2022 transfer-fee-config authority and
/// the withdraw-withheld authority of the launched mint. Because no instruction changes the
/// fee rate, the tax is frozen; and withheld fees can only ever be pulled to the vault.
pub const FEE_SEED: &[u8] = b"fee";

/// Solum Venue ABI v1: an allowlisted swap venue MUST expose an Anchor-compatible
/// `swap(amount_in: u64)` instruction whose accounts begin with
/// `[vault_authority (signer), funding_vault (w), stock_vault (w), ..venue pool accounts]`,
/// pulling `amount_in` from `funding_vault` and depositing the swap output into `stock_vault`.
/// This is the discriminator for that instruction: sha256("global:swap")[..8].
pub const SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

#[program]
pub mod solum {
    use super::*;

    /// One-time registration of a vault for a launched token. Sets the immutable-ish policy:
    /// which stocks the vault may ever hold, which swap venue backing may route through, the
    /// fee rate, and the engine/admin authorities. Grants NO withdrawal power to anyone.
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        backing_fee_bps: u16,
        max_slippage_bps: u16,
        engine: Pubkey,
        swap_venue: Pubkey,
        funding_mint: Pubkey,
        stocks: Vec<Pubkey>,
    ) -> Result<()> {
        require!(backing_fee_bps <= MAX_FEE_BPS, SolumError::FeeTooHigh);
        require!(max_slippage_bps <= MAX_SLIPPAGE_BPS, SolumError::SlippageTooHigh);
        require!(!stocks.is_empty(), SolumError::NoStocks);
        require!(stocks.len() <= MAX_STOCKS, SolumError::TooManyStocks);
        require!(engine != Pubkey::default(), SolumError::InvalidEngine);
        require!(swap_venue != Pubkey::default(), SolumError::InvalidVenue);
        require!(funding_mint != Pubkey::default(), SolumError::WrongMint);

        // Deny-by-default allowlist hygiene: no zero mints, no duplicates, and the funding
        // asset may never be one of the backing stocks (else add_backing could spend a stock
        // reserve as "funding" and swap it out).
        for (i, s) in stocks.iter().enumerate() {
            require!(*s != Pubkey::default(), SolumError::InvalidStock);
            require!(*s != funding_mint, SolumError::FundingIsStock);
            for other in &stocks[i + 1..] {
                require!(other != s, SolumError::DuplicateStock);
            }
        }

        let cfg = &mut ctx.accounts.config;
        cfg.token_mint = ctx.accounts.token_mint.key();
        cfg.admin = ctx.accounts.admin.key();
        cfg.engine = engine;
        cfg.swap_venue = swap_venue;
        cfg.funding_mint = funding_mint;
        cfg.backing_fee_bps = backing_fee_bps;
        cfg.max_slippage_bps = max_slippage_bps;
        cfg.paused = false;
        cfg.stock_count = stocks.len() as u8;
        cfg.stock_allowlist = [Pubkey::default(); MAX_STOCKS];
        for (i, s) in stocks.iter().enumerate() {
            cfg.stock_allowlist[i] = *s;
        }
        cfg.vault_authority_bump = ctx.bumps.vault_authority;
        cfg.config_bump = ctx.bumps.config;
        cfg.reserved = [0u8; 128];

        emit!(VaultInitialized {
            token_mint: cfg.token_mint,
            admin: cfg.admin,
            engine,
            swap_venue,
            backing_fee_bps,
            stock_count: cfg.stock_count,
        });
        Ok(())
    }

    /// Redeem `amount` tokens for a pro-rata slice of EVERY stock in the vault. This is the
    /// floor. User-signed only. Burn happens before any transfer. Payout per stock is
    /// `amount * vault_balance / supply_before`, computed in u128 and rounded DOWN — the
    /// redeemer never receives more than their exact share, so the per-token floor for
    /// remaining holders is preserved (and nudged up by the rounding remainder).
    ///
    /// `remaining_accounts` must be exactly `stock_count` triples, in allowlist order:
    ///   [ stock_mint_i, vault_stock_ata_i, redeemer_stock_ata_i ]  for i in 0..stock_count.
    pub fn redeem<'info>(
        ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>,
        amount: u64,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        // Redemption is deliberately NOT pausable: the floor must always be reachable, even by
        // a compromised admin. `paused` gates only the value-ADDING paths (add_backing).
        require!(amount > 0, SolumError::ZeroAmount);

        // Denominator captured BEFORE the burn. Burning first would shrink supply and
        // over-pay the redeemer at the expense of everyone else's floor.
        let supply_before = ctx.accounts.token_mint.supply;
        require!(supply_before > 0, SolumError::EmptySupply);
        require!(amount <= supply_before, SolumError::AmountExceedsSupply);

        let stock_count = cfg.stock_count as usize;
        let rem = ctx.remaining_accounts;
        require!(rem.len() == stock_count * 3, SolumError::BadRemainingAccounts);

        // ---- State change first: burn the redeemed tokens. ----
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.redeemer_token_account.to_account_info(),
                    authority: ctx.accounts.redeemer.to_account_info(),
                },
            ),
            amount,
        )?;

        // Vault PDA signs each transfer out. Seeds bound to this vault's (token_mint, admin).
        let mint_key = cfg.token_mint;
        let admin_key = cfg.admin;
        let vault_bump = cfg.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[VAULT_SEED, mint_key.as_ref(), admin_key.as_ref(), &[vault_bump]]];

        // ---- Pro-rata payout of each allowlisted stock. ----
        for i in 0..stock_count {
            let stock_mint_ai = &rem[i * 3];
            let vault_ata_ai = &rem[i * 3 + 1];
            let user_ata_ai = &rem[i * 3 + 2];

            // The mint at position i MUST be exactly the allowlisted stock at index i.
            require_keys_eq!(
                stock_mint_ai.key(),
                cfg.stock_allowlist[i],
                SolumError::StockMismatch
            );

            // Deserialize + validate the token accounts (owner/mint), reading balances.
            let vault_ata = InterfaceAccount::<TokenAccount>::try_from(vault_ata_ai)?;
            let user_ata = InterfaceAccount::<TokenAccount>::try_from(user_ata_ai)?;

            // Source MUST be a vault-owned account for exactly this stock. This is what makes
            // a hostile remaining-accounts set unable to redirect the source of funds.
            require_keys_eq!(
                vault_ata.owner,
                ctx.accounts.vault_authority.key(),
                SolumError::BadVaultOwner
            );
            require_keys_eq!(vault_ata.mint, cfg.stock_allowlist[i], SolumError::StockMismatch);
            require_keys_eq!(user_ata.mint, cfg.stock_allowlist[i], SolumError::StockMismatch);

            // Pro-rata payout: amount * vault_balance / supply_before (u128, round down).
            // Pure + checked; exhaustively unit-tested in `mod tests`.
            let payout: u64 = redeem_payout(amount, vault_ata.amount, supply_before)?;

            if payout == 0 {
                continue;
            }

            let stock_mint = InterfaceAccount::<Mint>::try_from(stock_mint_ai)?;

            // Stock transfer goes through the STOCK token program (Token-2022 for xStocks),
            // which is distinct from the burn's token program (classic SPL for a pump.fun coin).
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.stock_token_program.to_account_info(),
                    TransferChecked {
                        from: vault_ata_ai.to_account_info(),
                        mint: stock_mint_ai.to_account_info(),
                        to: user_ata_ai.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer_seeds,
                ),
                payout,
                stock_mint.decimals,
            )?;
        }

        emit!(Redeemed {
            token_mint: mint_key,
            redeemer: ctx.accounts.redeemer.key(),
            amount,
            supply_before,
        });
        Ok(())
    }

    /// Admin-only: pause/unpause. Halts redemptions + backing; moves no assets.
    pub fn set_pause(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(ParamsUpdated {
            token_mint: ctx.accounts.config.token_mint,
            field: if paused { "paused".to_string() } else { "unpaused".to_string() },
        });
        Ok(())
    }

    /// Admin-only: rotate the engine trigger authority. The engine can only ever trigger
    /// add-backing; rotating it grants no withdrawal power.
    pub fn set_engine(ctx: Context<AdminOnly>, new_engine: Pubkey) -> Result<()> {
        require!(new_engine != Pubkey::default(), SolumError::InvalidEngine);
        ctx.accounts.config.engine = new_engine;
        emit!(ParamsUpdated {
            token_mint: ctx.accounts.config.token_mint,
            field: "engine".to_string(),
        });
        Ok(())
    }

    /// Publish a stock price to the per-stock PriceFeed PDA. Admin-signed. DEVNET-ONLY oracle
    /// stand-in (compiled only under the `devnet-oracle` feature). In production the `pyth-oracle`
    /// feature reads a Pyth PriceUpdateV2 instead — see `set_feed` + `add_backing`.
    #[cfg(feature = "devnet-oracle")]
    pub fn set_price(ctx: Context<SetPrice>, price: u64, expo: i32) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(
            cfg.stock_allowlist[..cfg.stock_count as usize].contains(&ctx.accounts.stock_mint.key()),
            SolumError::StockMismatch
        );
        require!(price > 0, SolumError::BadOracle);
        require!(expo <= 0, SolumError::BadOracle); // stocks priced with non-positive expo
        let slot = Clock::get()?.slot;
        let pf = &mut ctx.accounts.price_feed;
        pf.stock_mint = ctx.accounts.stock_mint.key();
        pf.price = price;
        pf.expo = expo;
        pf.publish_slot = slot;
        emit!(PriceSet { stock_mint: pf.stock_mint, price, expo, slot });
        Ok(())
    }

    /// Bind a stock to its Pyth price-feed id (per-vault, per-stock). Admin-signed. Replaces
    /// `set_price` in production: the admin no longer publishes a price, only points at a Pyth
    /// feed — after which `add_backing` reads the live Pyth price directly. pyth-oracle only.
    #[cfg(feature = "pyth-oracle")]
    pub fn set_feed(ctx: Context<SetFeed>, feed_id: [u8; 32]) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(
            cfg.stock_allowlist[..cfg.stock_count as usize].contains(&ctx.accounts.stock_mint.key()),
            SolumError::StockMismatch
        );
        let so = &mut ctx.accounts.stock_oracle;
        so.stock_mint = ctx.accounts.stock_mint.key();
        so.feed_id = feed_id;
        emit!(FeedSet { stock_mint: so.stock_mint, feed_id });
        Ok(())
    }

    /// Engine-triggered backing: spend up to `amount_in` of the funding asset through the
    /// allowlisted venue and deposit an allowlisted stock into the vault.
    ///
    /// # Why this can never lose value
    /// The program itself names the ONLY two vault accounts the swap may touch
    /// (`funding_vault`, `stock_vault`); the engine supplies only the venue's own pool
    /// accounts. After the CPI the program reloads both and enforces, in the vault's favor:
    ///   * funding did not fall by more than `amount_in` (no overspend), and
    ///   * stock rose by at least `oracle_fair_out * (1 - max_slippage)` (fair fill).
    /// Whatever the venue did internally, the vault ends up richer or the transaction reverts,
    /// and the venue cannot leave a delegate/authority behind on a vault account. A compromised
    /// engine can waste a transaction but cannot extract. (It CAN, against a cooperating
    /// allowlisted venue, under-fill by up to `max_slippage_bps` — so the venue must be a
    /// reviewed adapter and the slippage cap set conservatively.)
    pub fn add_backing<'info>(
        ctx: Context<'_, '_, 'info, 'info, AddBacking<'info>>,
        amount_in: u64,
    ) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, SolumError::Paused);
        require!(amount_in > 0, SolumError::ZeroAmount);

        let stock_mint_key = ctx.accounts.stock_mint.key();
        let vault_key = ctx.accounts.vault_authority.key();

        // Stock must be allowlisted; venue must be THE allowlisted venue.
        require!(
            cfg.stock_allowlist[..cfg.stock_count as usize].contains(&stock_mint_key),
            SolumError::StockMismatch
        );
        require_keys_eq!(ctx.accounts.swap_venue.key(), cfg.swap_venue, SolumError::WrongVenue);

        // The two vault accounts must be vault-owned and correctly minted.
        require_keys_eq!(ctx.accounts.funding_vault.owner, vault_key, SolumError::BadVaultOwner);
        require_keys_eq!(ctx.accounts.stock_vault.owner, vault_key, SolumError::BadVaultOwner);
        require_keys_eq!(ctx.accounts.stock_vault.mint, stock_mint_key, SolumError::StockMismatch);
        require_keys_eq!(
            ctx.accounts.funding_vault.mint,
            ctx.accounts.funding_mint.key(),
            SolumError::WrongMint
        );

        // Oracle read: (oracle_price, pe) come from the compiled source. This is the ONLY use of
        // the oracle — it sets the min-out floor; the net-effect guard below does the real work.
        #[cfg(feature = "devnet-oracle")]
        let (oracle_price, pe): (u128, u32) = {
            let pf = &ctx.accounts.price_feed;
            let slot = Clock::get()?.slot;
            require!(slot.saturating_sub(pf.publish_slot) <= MAX_PRICE_STALENESS_SLOTS, SolumError::StaleOracle);
            require!(pf.price > 0 && pf.expo <= 0, SolumError::BadOracle);
            (pf.price as u128, (-pf.expo) as u32)
        };
        #[cfg(feature = "pyth-oracle")]
        let (oracle_price, pe): (u128, u32) = {
            let so = &ctx.accounts.stock_oracle;
            let pu = &ctx.accounts.price_update;
            let p = pu
                .get_price_no_older_than(&Clock::get()?, MAX_PRICE_AGE_SECONDS, &so.feed_id)
                .map_err(|_| error!(SolumError::StaleOracle))?;
            // Confidence-conservative: use the LOWER bound (price - conf) so the vault requires
            // MORE stock out, never less, when the feed is uncertain.
            let conservative = (p.price as i128).saturating_sub(p.conf as i128);
            require!(conservative > 0, SolumError::BadOracle);
            require!(p.exponent <= 0 && p.exponent >= -18, SolumError::BadOracle);
            (conservative as u128, (-p.exponent) as u32)
        };

        let pre_stock = ctx.accounts.stock_vault.amount;
        let pre_funding = ctx.accounts.funding_vault.amount;
        require!(pre_funding >= amount_in, SolumError::InsufficientFunding);

        // ---- CPI the allowlisted venue's swap(amount_in). ----
        let mint_key = cfg.token_mint;
        let admin_key = cfg.admin;
        let vault_bump = cfg.vault_authority_bump;
        let signer_seeds: &[&[&[u8]]] =
            &[&[VAULT_SEED, mint_key.as_ref(), admin_key.as_ref(), &[vault_bump]]];

        let mut metas = vec![
            AccountMeta::new_readonly(vault_key, true),
            AccountMeta::new(ctx.accounts.funding_vault.key(), false),
            AccountMeta::new(ctx.accounts.stock_vault.key(), false),
        ];
        let mut infos = vec![
            ctx.accounts.vault_authority.to_account_info(),
            ctx.accounts.funding_vault.to_account_info(),
            ctx.accounts.stock_vault.to_account_info(),
        ];
        for ai in ctx.remaining_accounts.iter() {
            // Defense in depth: the venue accounts must be the venue's own. Reject any
            // vault-owned token account here, so a hostile allowlisted venue can't be handed a
            // SECOND vault account (e.g. another stock vault) to drain under the vault
            // authority's signature. Only funding_vault + stock_vault (named above) are ever
            // vault-owned in this CPI, and both are bounded by the net-effect guard.
            // The venue accounts must be the venue's own. Reject the two vault accounts by key
            // (they are prepended, never re-listed here), and reject any TOKEN ACCOUNT owned by
            // the vault authority. A mint is token-program-owned but is not a token account, so
            // it parses as neither and is correctly allowed through.
            require_keys_neq!(ai.key(), ctx.accounts.funding_vault.key(), SolumError::BadVaultOwner);
            require_keys_neq!(ai.key(), ctx.accounts.stock_vault.key(), SolumError::BadVaultOwner);
            if *ai.owner == anchor_spl::token::ID || *ai.owner == spl_token_2022::ID {
                if let Ok(ta) = InterfaceAccount::<TokenAccount>::try_from(ai) {
                    require_keys_neq!(ta.owner, vault_key, SolumError::BadVaultOwner);
                }
            }
            metas.push(AccountMeta {
                pubkey: ai.key(),
                is_signer: ai.is_signer,
                is_writable: ai.is_writable,
            });
            infos.push(ai.to_account_info());
        }
        infos.push(ctx.accounts.swap_venue.to_account_info());

        let mut data = SWAP_DISCRIMINATOR.to_vec();
        data.extend_from_slice(&amount_in.to_le_bytes());

        invoke_signed(
            &Instruction { program_id: ctx.accounts.swap_venue.key(), accounts: metas, data },
            &infos,
            signer_seeds,
        )?;

        // ---- Net-effect guard: the vault must end up richer by a fair margin. ----
        ctx.accounts.stock_vault.reload()?;
        ctx.accounts.funding_vault.reload()?;
        let post_stock = ctx.accounts.stock_vault.amount;
        let post_funding = ctx.accounts.funding_vault.amount;

        require!(post_funding <= pre_funding, SolumError::FundingIncreased);
        let actual_in = pre_funding - post_funding;
        require!(actual_in <= amount_in, SolumError::OverSpend);
        require!(post_stock >= pre_stock, SolumError::StockDecreased);
        let actual_out = post_stock - pre_stock;

        // A balance-delta guard is not enough: a hostile venue holding the vault_authority
        // signature could `approve` a delegate or `set_authority` on a vault account (balances
        // unchanged) and drain it in a LATER transaction. Require both vault accounts came out
        // untampered — still vault-owned, no delegate, no close authority.
        for va in [&ctx.accounts.funding_vault, &ctx.accounts.stock_vault] {
            require_keys_eq!(va.owner, vault_key, SolumError::VenueTampered);
            require!(va.delegate.is_none(), SolumError::VenueTampered);
            require!(va.close_authority.is_none(), SolumError::VenueTampered);
        }

        // Oracle-justified minimum stock output (pure + checked; unit-tested in `mod tests`).
        let sd = ctx.accounts.stock_mint.decimals as u32;
        let qd = ctx.accounts.funding_mint.decimals as u32;
        let floor = min_out_floor(actual_in, oracle_price, pe, sd, qd, cfg.max_slippage_bps)?;
        require!(actual_out as u128 >= floor, SolumError::InsufficientBacking);

        emit!(Backed {
            token_mint: mint_key,
            stock_mint: stock_mint_key,
            amount_in: actual_in,
            amount_out: actual_out,
        });
        Ok(())
    }

    /// Pull withheld Token-2022 transfer fees from the mint into the vault-owned fee account.
    /// Permissionless: the destination is constrained to a vault-owned account for this exact
    /// mint, so the only thing anyone can do is move fees INTO the vault — never out, never
    /// elsewhere. (Sweeping withheld fees from holder accounts to the mint is the standard
    /// permissionless Token-2022 `harvest_withheld_tokens_to_mint`, done off-program first.)
    pub fn harvest_fees(ctx: Context<HarvestFees>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.fee_vault.owner,
            ctx.accounts.vault_authority.key(),
            SolumError::BadVaultOwner
        );
        require_keys_eq!(
            ctx.accounts.fee_vault.mint,
            ctx.accounts.token_mint.key(),
            SolumError::WrongMint
        );

        let mint_key = ctx.accounts.token_mint.key();
        let fee_bump = ctx.bumps.fee_authority;
        let seeds: &[&[&[u8]]] = &[&[FEE_SEED, mint_key.as_ref(), &[fee_bump]]];

        let ix = spl_token_2022::extension::transfer_fee::instruction::withdraw_withheld_tokens_from_mint(
            &spl_token_2022::ID,
            &mint_key,
            &ctx.accounts.fee_vault.key(),
            &ctx.accounts.fee_authority.key(),
            &[],
        )?;
        invoke_signed(
            &ix,
            &[
                ctx.accounts.token_mint.to_account_info(),
                ctx.accounts.fee_vault.to_account_info(),
                ctx.accounts.fee_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            seeds,
        )?;

        ctx.accounts.fee_vault.reload()?;
        emit!(FeesHarvested {
            token_mint: mint_key,
            fee_vault: ctx.accounts.fee_vault.key(),
            balance: ctx.accounts.fee_vault.amount,
        });
        Ok(())
    }

    /// Deposit backing stock into the vault — the manual-buyback path. Permissionless: anyone
    /// (the operator, a partner, a treasury) can ADD backing, which only ever raises the floor.
    /// Every deposit emits an event, giving verifiable on-chain provenance for each buyback.
    pub fn deposit_stock(ctx: Context<DepositStock>, amount: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(amount > 0, SolumError::ZeroAmount);
        let stock_mint_key = ctx.accounts.stock_mint.key();
        require!(
            cfg.stock_allowlist[..cfg.stock_count as usize].contains(&stock_mint_key),
            SolumError::StockMismatch
        );
        require_keys_eq!(
            ctx.accounts.stock_vault.owner,
            ctx.accounts.vault_authority.key(),
            SolumError::BadVaultOwner
        );
        require_keys_eq!(ctx.accounts.stock_vault.mint, stock_mint_key, SolumError::StockMismatch);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.stock_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.depositor_stock_account.to_account_info(),
                    mint: ctx.accounts.stock_mint.to_account_info(),
                    to: ctx.accounts.stock_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.stock_mint.decimals,
        )?;

        emit!(BackingDeposited {
            token_mint: cfg.token_mint,
            stock_mint: stock_mint_key,
            depositor: ctx.accounts.depositor.key(),
            amount,
        });
        Ok(())
    }

    // ----------------------------- Stake-to-earn -----------------------------

    /// Create a stake pool for `coin_mint`, rewarding stakers in `reward_mint` (one allowlisted
    /// stock). Admin-signed; PDAs bound to (coin_mint, admin), mirroring the vault. The custody +
    /// reward-vault token accounts (owned by the stake authority) are pinned here so accounting can
    /// never be pointed at a different account later.
    pub fn init_stake_pool(ctx: Context<InitStakePool>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        p.coin_mint = ctx.accounts.coin_mint.key();
        p.reward_mint = ctx.accounts.reward_mint.key();
        p.admin = ctx.accounts.admin.key();
        p.staked_custody = ctx.accounts.staked_custody.key();
        p.reward_vault = ctx.accounts.reward_vault.key();
        p.total_staked = 0;
        p.acc_reward_per_share = 0;
        p.last_reward_balance = 0;
        p.stake_authority_bump = ctx.bumps.stake_authority;
        p.bump = ctx.bumps.pool;
        p.reserved = [0u8; 64];
        emit!(StakePoolInitialized {
            coin_mint: p.coin_mint,
            reward_mint: p.reward_mint,
            admin: p.admin,
        });
        Ok(())
    }

    /// Fold newly-arrived reward stock into the accumulator. Permissionless + idempotent, so a
    /// passive admin can never stall rewards.
    pub fn sync_rewards(ctx: Context<SyncRewards>) -> Result<()> {
        let bal = ctx.accounts.reward_vault.amount;
        sync_pool(&mut ctx.accounts.pool, bal)
    }

    /// Stake `amount` coins to earn reward stock. Settles any pending reward on the existing
    /// position first (its `reward_debt` is about to be reset), then locks the coins in custody.
    pub fn stake(ctx: Context<Stake>, amount: u64) -> Result<()> {
        require!(amount > 0, SolumError::ZeroAmount);
        let bal = ctx.accounts.reward_vault.amount;
        sync_pool(&mut ctx.accounts.pool, bal)?;

        let pool_key = ctx.accounts.pool.key();
        let auth_bump = ctx.accounts.pool.stake_authority_bump;
        let acc = ctx.accounts.pool.acc_reward_per_share;
        let signer: &[&[&[u8]]] = &[&[STAKE_AUTH_SEED, pool_key.as_ref(), &[auth_bump]]];

        let pending = pending_reward(
            ctx.accounts.stake_account.amount,
            acc,
            ctx.accounts.stake_account.reward_debt,
        )?;
        if pending > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.reward_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.reward_vault.to_account_info(),
                        mint: ctx.accounts.reward_mint.to_account_info(),
                        to: ctx.accounts.owner_reward_account.to_account_info(),
                        authority: ctx.accounts.stake_authority.to_account_info(),
                    },
                    signer,
                ),
                pending,
                ctx.accounts.reward_mint.decimals,
            )?;
            ctx.accounts.pool.last_reward_balance =
                ctx.accounts.pool.last_reward_balance.saturating_sub(pending);
            emit!(RewardClaimed { pool: pool_key, owner: ctx.accounts.owner.key(), amount: pending });
        }

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.coin_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.owner_coin_account.to_account_info(),
                    mint: ctx.accounts.coin_mint.to_account_info(),
                    to: ctx.accounts.staked_custody.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.coin_mint.decimals,
        )?;

        let owner_key = ctx.accounts.owner.key();
        let acc_now = ctx.accounts.pool.acc_reward_per_share;
        let sa = &mut ctx.accounts.stake_account;
        sa.owner = owner_key;
        sa.pool = pool_key;
        sa.bump = ctx.bumps.stake_account;
        sa.amount = sa.amount.checked_add(amount).ok_or(SolumError::MathOverflow)?;
        sa.reward_debt = reward_debt_for(sa.amount, acc_now)?;
        let new_amount = sa.amount;
        ctx.accounts.pool.total_staked = ctx
            .accounts
            .pool
            .total_staked
            .checked_add(amount)
            .ok_or(SolumError::MathOverflow)?;
        emit!(Staked { pool: pool_key, owner: owner_key, amount, total: new_amount });
        Ok(())
    }

    /// Claim accrued reward stock for the caller's own stake. Anyone-safe: pays only the signer.
    pub fn claim(ctx: Context<ClaimReward>) -> Result<()> {
        let bal = ctx.accounts.reward_vault.amount;
        sync_pool(&mut ctx.accounts.pool, bal)?;
        let pool_key = ctx.accounts.pool.key();
        let auth_bump = ctx.accounts.pool.stake_authority_bump;
        let acc = ctx.accounts.pool.acc_reward_per_share;
        let pending = pending_reward(
            ctx.accounts.stake_account.amount,
            acc,
            ctx.accounts.stake_account.reward_debt,
        )?;
        require!(pending > 0, SolumError::ZeroAmount);
        let signer: &[&[&[u8]]] = &[&[STAKE_AUTH_SEED, pool_key.as_ref(), &[auth_bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.reward_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.owner_reward_account.to_account_info(),
                    authority: ctx.accounts.stake_authority.to_account_info(),
                },
                signer,
            ),
            pending,
            ctx.accounts.reward_mint.decimals,
        )?;
        ctx.accounts.pool.last_reward_balance =
            ctx.accounts.pool.last_reward_balance.saturating_sub(pending);
        let amt = ctx.accounts.stake_account.amount;
        ctx.accounts.stake_account.reward_debt = reward_debt_for(amt, acc)?;
        emit!(RewardClaimed { pool: pool_key, owner: ctx.accounts.owner.key(), amount: pending });
        Ok(())
    }

    /// Unstake `amount` coins, settling pending reward first. Returns the coins from custody.
    pub fn unstake(ctx: Context<Unstake>, amount: u64) -> Result<()> {
        require!(amount > 0, SolumError::ZeroAmount);
        require!(
            amount <= ctx.accounts.stake_account.amount,
            SolumError::InsufficientStake
        );
        let bal = ctx.accounts.reward_vault.amount;
        sync_pool(&mut ctx.accounts.pool, bal)?;
        let pool_key = ctx.accounts.pool.key();
        let auth_bump = ctx.accounts.pool.stake_authority_bump;
        let acc = ctx.accounts.pool.acc_reward_per_share;
        let signer: &[&[&[u8]]] = &[&[STAKE_AUTH_SEED, pool_key.as_ref(), &[auth_bump]]];

        let pending = pending_reward(
            ctx.accounts.stake_account.amount,
            acc,
            ctx.accounts.stake_account.reward_debt,
        )?;
        if pending > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.reward_token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.reward_vault.to_account_info(),
                        mint: ctx.accounts.reward_mint.to_account_info(),
                        to: ctx.accounts.owner_reward_account.to_account_info(),
                        authority: ctx.accounts.stake_authority.to_account_info(),
                    },
                    signer,
                ),
                pending,
                ctx.accounts.reward_mint.decimals,
            )?;
            ctx.accounts.pool.last_reward_balance =
                ctx.accounts.pool.last_reward_balance.saturating_sub(pending);
            emit!(RewardClaimed { pool: pool_key, owner: ctx.accounts.owner.key(), amount: pending });
        }

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.coin_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.staked_custody.to_account_info(),
                    mint: ctx.accounts.coin_mint.to_account_info(),
                    to: ctx.accounts.owner_coin_account.to_account_info(),
                    authority: ctx.accounts.stake_authority.to_account_info(),
                },
                signer,
            ),
            amount,
            ctx.accounts.coin_mint.decimals,
        )?;

        let owner_key = ctx.accounts.stake_account.owner;
        let acc_now = ctx.accounts.pool.acc_reward_per_share;
        let sa = &mut ctx.accounts.stake_account;
        sa.amount = sa.amount.checked_sub(amount).ok_or(SolumError::InsufficientStake)?;
        sa.reward_debt = reward_debt_for(sa.amount, acc_now)?;
        let new_amount = sa.amount;
        ctx.accounts.pool.total_staked = ctx
            .accounts
            .pool
            .total_staked
            .checked_sub(amount)
            .ok_or(SolumError::MathOverflow)?;
        emit!(Unstaked { pool: pool_key, owner: owner_key, amount, total: new_amount });
        Ok(())
    }

    // ===================== No-loss real-stock jackpot =====================
    // Fees fund a prize pot of real stock; each epoch a TWAB-weighted holder is drawn from a
    // snapshotter-committed Merkle root using verifiable randomness, and claims the whole pot.
    // No-loss: a holder's coins are never touched. See docs/JACKPOT.md.

    /// One-time: create the jackpot for a coin. Binds the prize mint, the snapshotter allowed to
    /// commit epoch roots, the epoch length, and the pot custody (a prize-mint token account owned
    /// by the jackpot authority PDA — no private key, no withdraw path).
    pub fn init_jackpot(ctx: Context<InitJackpot>, epoch_len: i64) -> Result<()> {
        require!(epoch_len > 0, SolumError::ZeroAmount);
        let j = &mut ctx.accounts.jackpot;
        j.coin_mint = ctx.accounts.coin_mint.key();
        j.prize_mint = ctx.accounts.prize_mint.key();
        j.admin = ctx.accounts.admin.key();
        j.snapshotter = ctx.accounts.snapshotter.key();
        j.pot_custody = ctx.accounts.pot_custody.key();
        j.epoch_len = epoch_len;
        j.current_epoch = 0;
        j.epoch_start = 0;
        j.twab_root = [0u8; 32];
        j.total_tickets = 0;
        j.winning_ticket = 0;
        j.phase = PHASE_OPEN;
        j.jackpot_authority_bump = ctx.bumps.jackpot_authority;
        j.bump = ctx.bumps.jackpot;
        j.randomness_account = Pubkey::default();
        j.commit_slot = 0;
        j.reserved = [0u8; 24];
        emit!(JackpotInitialized {
            jackpot: j.key(),
            coin_mint: j.coin_mint,
            prize_mint: j.prize_mint
        });
        Ok(())
    }

    /// Snapshotter posts the epoch's TWAB Merkle root + total ticket count, opening a draw. The
    /// full per-holder snapshot is published off-chain and is recomputable from on-chain transfer
    /// history, so a wrong root is provable fraud.
    pub fn commit_epoch(
        ctx: Context<CommitEpoch>,
        root: [u8; 32],
        total_tickets: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let j = &mut ctx.accounts.jackpot;
        require!(j.phase == PHASE_OPEN, SolumError::JackpotBusy);
        require!(total_tickets > 0, SolumError::ZeroAmount);
        j.current_epoch = j
            .current_epoch
            .checked_add(1)
            .ok_or(SolumError::MathOverflow)?;
        j.epoch_start = now;
        j.twab_root = root;
        j.total_tickets = total_tickets;
        j.winning_ticket = 0;
        j.phase = PHASE_COMMITTED;
        emit!(EpochCommitted {
            jackpot: j.key(),
            epoch: j.current_epoch,
            total_tickets
        });
        Ok(())
    }

    /// Fix the winning ticket for the current epoch from verifiable randomness, once the epoch has
    /// elapsed (a draw can't settle early). Under `devnet-vrf` the randomness is injected by the
    /// snapshotter for local testing; production uses `switchboard-vrf` (see request_draw/settle).
    #[cfg(all(feature = "devnet-vrf", not(feature = "switchboard-vrf")))]
    pub fn settle_draw(ctx: Context<SettleDraw>, randomness: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let j = &mut ctx.accounts.jackpot;
        require!(j.phase == PHASE_COMMITTED, SolumError::JackpotNotReady);
        require!(
            now >= j.epoch_start.saturating_add(j.epoch_len),
            SolumError::EpochNotElapsed
        );
        j.winning_ticket = winning_ticket(&randomness, j.total_tickets)?;
        j.phase = PHASE_SETTLED;
        emit!(DrawSettled {
            jackpot: j.key(),
            epoch: j.current_epoch,
            winning_ticket: j.winning_ticket
        });
        Ok(())
    }

    /// [switchboard-vrf] Bind a freshly-committed Switchboard On-Demand randomness account to this
    /// epoch, once the epoch has elapsed. The value is seeded from the current slot and revealed
    /// later by the oracle network, so no caller — including the snapshotter — can predict or grind
    /// it. Permissionless.
    #[cfg(feature = "switchboard-vrf")]
    pub fn request_draw(ctx: Context<RequestDraw>) -> Result<()> {
        let clock = Clock::get()?;
        let rd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
            .map_err(|_| error!(SolumError::BadOracle))?;
        // Must be committed at the current slot: guarantees the value is not yet knowable.
        require!(rd.seed_slot == clock.slot, SolumError::BadOracle);
        let j = &mut ctx.accounts.jackpot;
        require!(j.phase == PHASE_COMMITTED, SolumError::JackpotNotReady);
        require!(
            clock.unix_timestamp >= j.epoch_start.saturating_add(j.epoch_len),
            SolumError::EpochNotElapsed
        );
        j.randomness_account = ctx.accounts.randomness.key();
        j.commit_slot = rd.seed_slot;
        j.phase = PHASE_REQUESTED;
        emit!(DrawRequested {
            jackpot: j.key(),
            epoch: j.current_epoch,
            commit_slot: rd.seed_slot
        });
        Ok(())
    }

    /// [switchboard-vrf] Read the revealed randomness for the bound account and fix the winning
    /// ticket. Reverts until the oracle has revealed (`get_value` errors), and accepts only the
    /// exact account + commitment bound at request time — so a caller can't swap in a value they
    /// chose. Permissionless.
    #[cfg(feature = "switchboard-vrf")]
    pub fn settle_draw(ctx: Context<SettleDrawVrf>) -> Result<()> {
        let clock = Clock::get()?;
        require!(
            ctx.accounts.randomness.key() == ctx.accounts.jackpot.randomness_account,
            SolumError::BadOracle
        );
        let rd = RandomnessAccountData::parse(ctx.accounts.randomness.data.borrow())
            .map_err(|_| error!(SolumError::BadOracle))?;
        let j = &mut ctx.accounts.jackpot;
        require!(j.phase == PHASE_REQUESTED, SolumError::JackpotNotReady);
        require!(rd.seed_slot == j.commit_slot, SolumError::BadOracle); // not re-committed
        let value: [u8; 32] = rd
            .get_value(clock.slot)
            .map_err(|_| error!(SolumError::StaleOracle))?;
        j.winning_ticket = winning_ticket(&value, j.total_tickets)?;
        j.phase = PHASE_SETTLED;
        emit!(DrawSettled {
            jackpot: j.key(),
            epoch: j.current_epoch,
            winning_ticket: j.winning_ticket
        });
        Ok(())
    }

    /// The holder whose ticket range contains the winning ticket claims the entire pot. Proves
    /// inclusion of their `(owner, ticket_start, tickets)` leaf in the committed root and that
    /// `ticket_start ≤ winning_ticket < ticket_start + tickets`. The leaf binds to the signer's
    /// pubkey, so no one can claim on another holder's behalf. No-loss: only the pot moves.
    pub fn claim_prize(
        ctx: Context<ClaimPrize>,
        ticket_start: u64,
        tickets: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        require!(
            ctx.accounts.jackpot.phase == PHASE_SETTLED,
            SolumError::JackpotNotReady
        );
        let leaf = hash_leaf(&ctx.accounts.winner.key(), ticket_start, tickets);
        require!(
            verify_merkle(&proof, &ctx.accounts.jackpot.twab_root, leaf),
            SolumError::BadProof
        );
        require!(
            ticket_in_range(ctx.accounts.jackpot.winning_ticket, ticket_start, tickets)?,
            SolumError::NotWinner
        );
        let pot = ctx.accounts.pot_custody.amount;
        require!(pot > 0, SolumError::ZeroAmount);
        let jkey = ctx.accounts.jackpot.key();
        let auth_bump = ctx.accounts.jackpot.jackpot_authority_bump;
        let signer: &[&[&[u8]]] = &[&[JACKPOT_AUTH_SEED, jkey.as_ref(), &[auth_bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.prize_token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pot_custody.to_account_info(),
                    mint: ctx.accounts.prize_mint.to_account_info(),
                    to: ctx.accounts.winner_prize_account.to_account_info(),
                    authority: ctx.accounts.jackpot_authority.to_account_info(),
                },
                signer,
            ),
            pot,
            ctx.accounts.prize_mint.decimals,
        )?;
        let epoch = ctx.accounts.jackpot.current_epoch;
        ctx.accounts.jackpot.phase = PHASE_OPEN; // ready for the next epoch; blocks double-claim
        emit!(PrizeClaimed {
            jackpot: jkey,
            epoch,
            winner: ctx.accounts.winner.key(),
            amount: pot
        });
        Ok(())
    }
}

/// 10^n as u128, checked.
fn pow10(n: u32) -> Result<u128> {
    10u128.checked_pow(n).ok_or(error!(SolumError::MathOverflow))
}

/// Oracle-justified minimum stock output for `actual_in` funding spent, after the slippage
/// haircut. `oracle_price` × 10^(-pe) is the price of one whole stock in funding units; `sd`/`qd`
/// are the stock/funding decimals; `max_slippage_bps` is bounded ≤ MAX_SLIPPAGE_BPS by config.
///   fair_out = actual_in · 10^sd · 10^pe / (10^qd · oracle_price);  floor = fair_out · (1 − slip)
/// Every step is checked (no overflow, no div-by-zero), and a floor that rounds to zero is
/// rejected so a dust fill can't drain funding for nothing. This is the security-critical
/// arithmetic of `add_backing`, isolated here so it can be exhaustively unit-tested.
fn min_out_floor(
    actual_in: u64,
    oracle_price: u128,
    pe: u32,
    sd: u32,
    qd: u32,
    max_slippage_bps: u16,
) -> Result<u128> {
    let num = (actual_in as u128)
        .checked_mul(pow10(sd)?)
        .ok_or(SolumError::MathOverflow)?
        .checked_mul(pow10(pe)?)
        .ok_or(SolumError::MathOverflow)?;
    let den = pow10(qd)?
        .checked_mul(oracle_price)
        .ok_or(SolumError::MathOverflow)?;
    let fair_out = num.checked_div(den).ok_or(SolumError::MathOverflow)?;
    let floor = fair_out
        .checked_mul((10_000 - max_slippage_bps) as u128)
        .ok_or(SolumError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(SolumError::MathOverflow)?;
    require!(floor > 0, SolumError::InsufficientBacking);
    Ok(floor)
}

/// Pro-rata redemption payout: `amount * vault_balance / supply` in u128, rounded DOWN, fit to
/// u64. Rounding down guarantees a redeemer never receives more than their exact share — so the
/// per-token floor for everyone who stays is preserved (and nudged up by the truncated remainder).
/// This is the most security-critical arithmetic in the protocol; isolated here for unit testing.
fn redeem_payout(amount: u64, vault_balance: u64, supply: u64) -> Result<u64> {
    let p: u64 = (amount as u128)
        .checked_mul(vault_balance as u128)
        .ok_or(SolumError::MathOverflow)?
        .checked_div(supply as u128)
        .ok_or(SolumError::MathOverflow)?
        .try_into()
        .map_err(|_| SolumError::MathOverflow)?;
    Ok(p)
}

/// Fixed-point precision for the staking reward-per-share accumulator.
#[allow(dead_code)] // staking reward core — wired by the stake/claim instructions (next increment)
pub const REWARD_PRECISION: u128 = 1_000_000_000_000;

/// Fold newly-arrived reward tokens into the per-share accumulator:
/// `acc' = acc + reward_in · PRECISION / total_staked`. No-op when nothing is staked (rewards wait
/// for the next staker — never lost, never mis-credited) or nothing arrived. Checked. docs/STAKING.md.
#[allow(dead_code)]
fn acc_add(acc: u128, reward_in: u64, total_staked: u64) -> Result<u128> {
    if total_staked == 0 || reward_in == 0 {
        return Ok(acc);
    }
    let inc = (reward_in as u128)
        .checked_mul(REWARD_PRECISION)
        .ok_or(SolumError::MathOverflow)?
        .checked_div(total_staked as u128)
        .ok_or(SolumError::MathOverflow)?;
    acc.checked_add(inc).ok_or(error!(SolumError::MathOverflow))
}

/// Pending reward for a stake: `amount · acc / PRECISION − reward_debt`, floored at 0 and fit to
/// u64. `reward_debt` credits everything that accrued before this stake, so a joiner never claims
/// past rewards, and saturating the subtraction means pending is never negative. Checked.
#[allow(dead_code)]
fn pending_reward(amount: u64, acc: u128, reward_debt: u128) -> Result<u64> {
    let gross = (amount as u128)
        .checked_mul(acc)
        .ok_or(SolumError::MathOverflow)?
        .checked_div(REWARD_PRECISION)
        .ok_or(SolumError::MathOverflow)?;
    let net = gross.saturating_sub(reward_debt);
    u64::try_from(net).map_err(|_| error!(SolumError::MathOverflow))
}

/// `amount · acc / PRECISION` — the accumulator value already credited to a stake of `amount`.
/// Set as `reward_debt` whenever a stake's amount changes, so future `pending_reward` only counts
/// rewards that accrue afterward.
fn reward_debt_for(amount: u64, acc: u128) -> Result<u128> {
    (amount as u128)
        .checked_mul(acc)
        .ok_or(SolumError::MathOverflow)?
        .checked_div(REWARD_PRECISION)
        .ok_or(error!(SolumError::MathOverflow))
}

/// Fold the reward vault's newly-arrived balance into the accumulator. Only advances when there is
/// stake to distribute to — otherwise rewards wait in the vault for the first staker (never lost,
/// never mis-credited). Idempotent: calling it twice with the same balance is a no-op.
fn sync_pool(pool: &mut StakePool, reward_vault_balance: u64) -> Result<()> {
    if pool.total_staked > 0 {
        let reward_in = reward_vault_balance.saturating_sub(pool.last_reward_balance);
        pool.acc_reward_per_share =
            acc_add(pool.acc_reward_per_share, reward_in, pool.total_staked)?;
        pool.last_reward_balance = reward_vault_balance;
    }
    Ok(())
}

// --------------------- jackpot pure functions (unit-tested) ---------------------

/// The winning ticket index: the first 8 bytes of the VRF randomness as a little-endian u64,
/// reduced modulo `total`. (A tiny modulo bias across a u64 range is negligible for ticket counts.)
fn winning_ticket(randomness: &[u8; 32], total: u64) -> Result<u64> {
    require!(total > 0, SolumError::ZeroAmount);
    let mut b = [0u8; 8];
    b.copy_from_slice(&randomness[..8]);
    Ok(u64::from_le_bytes(b) % total)
}

/// keccak leaf for a holder's ticket range: `H(0x00 || owner || start_le || tickets_le)`. The
/// 0x00 domain tag separates leaves from internal nodes, so no proof can pass an internal node off
/// as a leaf (second-preimage protection).
fn hash_leaf(owner: &Pubkey, start: u64, tickets: u64) -> [u8; 32] {
    keccak::hashv(&[
        &[0x00u8],
        owner.as_ref(),
        &start.to_le_bytes(),
        &tickets.to_le_bytes(),
    ])
    .0
}

/// Internal Merkle node: `H(0x01 || sorted(a, b))`. Sorted pairs make proofs index-free.
fn hash_node(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let (x, y) = if a <= b { (a, b) } else { (b, a) };
    keccak::hashv(&[&[0x01u8], &x, &y]).0
}

/// Sorted-pair Merkle verify (OpenZeppelin-style): fold the proof into the leaf and compare to root.
fn verify_merkle(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for p in proof {
        computed = hash_node(computed, *p);
    }
    &computed == root
}

/// `start ≤ winning < start + tickets`, with the end addition checked against overflow.
fn ticket_in_range(winning: u64, start: u64, tickets: u64) -> Result<bool> {
    let end = start
        .checked_add(tickets)
        .ok_or(SolumError::MathOverflow)?;
    Ok(winning >= start && winning < end)
}

#[cfg(test)]
mod tests {
    use super::{
        acc_add, hash_leaf, hash_node, min_out_floor, pending_reward, redeem_payout,
        ticket_in_range, verify_merkle, winning_ticket,
    };
    use anchor_lang::prelude::Pubkey;

    #[test]
    fn basic_one_to_one() {
        // price 1 (expo 0), 6-dec both, spend 1.0 funding → require 1.0 stock, no slippage.
        assert_eq!(min_out_floor(1_000_000, 1, 0, 6, 6, 0).unwrap(), 1_000_000);
    }

    #[test]
    fn applies_slippage_haircut() {
        // 5% slippage → floor is 95% of fair.
        assert_eq!(min_out_floor(1_000_000, 1, 0, 6, 6, 500).unwrap(), 950_000);
    }

    #[test]
    fn lower_price_requires_more_out() {
        // The confidence-conservative Pyth read uses price−conf (a LOWER price); that must demand
        // MORE stock out, never less — i.e. more protective for the vault.
        let lo_price = min_out_floor(1_000_000, 1, 0, 6, 6, 0).unwrap();
        let hi_price = min_out_floor(1_000_000, 2, 0, 6, 6, 0).unwrap();
        assert!(lo_price > hi_price);
    }

    #[test]
    fn exponent_scales_price() {
        // price 100 with pe=2 == effective price 1.00 → same floor as the 1:1 case.
        assert_eq!(min_out_floor(1_000_000, 100, 2, 6, 6, 0).unwrap(), 1_000_000);
    }

    #[test]
    fn handles_decimal_mismatch() {
        // stock 8-dec, funding 6-dec, price 1 → fair = in · 10^8 / 10^6 = in · 100.
        assert_eq!(min_out_floor(1_000_000, 1, 0, 8, 6, 0).unwrap(), 100_000_000);
    }

    #[test]
    fn rejects_dust_floor() {
        // tiny spend at a huge price → floor rounds to 0 → rejected, not silently allowed.
        assert!(min_out_floor(1, 1_000_000_000_000, 0, 6, 6, 0).is_err());
    }

    #[test]
    fn guards_overflow_without_panicking() {
        // extreme inputs overflow the checked math → Err, never a panic.
        assert!(min_out_floor(u64::MAX, u128::MAX / 2, 30, 30, 0, 0).is_err());
    }

    // ---- redeem_payout: the redemption floor arithmetic ----

    #[test]
    fn payout_exact_half() {
        // redeem 50% of supply → exactly 50% of the vault balance.
        assert_eq!(redeem_payout(500, 1_000, 1_000).unwrap(), 500);
    }

    #[test]
    fn payout_rounds_down_never_overpays() {
        // 1 of 3 supply against a balance of 10 → 10/3 = 3.33 → 3, never 4.
        assert_eq!(redeem_payout(1, 10, 3).unwrap(), 3);
    }

    #[test]
    fn payout_full_redeem_takes_full_balance() {
        assert_eq!(redeem_payout(1_000, 777, 1_000).unwrap(), 777);
    }

    #[test]
    fn payout_tiny_share_rounds_to_zero() {
        // a single unit of a 1e9 supply against a 5-unit balance → 0 (handled by the caller's skip).
        assert_eq!(redeem_payout(1, 5, 1_000_000_000).unwrap(), 0);
    }

    #[test]
    fn payout_floor_preserved_sum_within_balance() {
        // Property: rounding down means N redeemers' payouts never sum above the vault balance —
        // the leftover remainder stays in the vault, nudging everyone else's floor UP.
        let (bal, supply, third) = (1_000_000u64, 1_000_000u64, 333_333u64);
        let p = redeem_payout(third, bal, supply).unwrap();
        assert!(p * 3 <= bal);
    }

    #[test]
    fn payout_zero_supply_errors_not_panics() {
        assert!(redeem_payout(1, 10, 0).is_err());
    }

    #[test]
    fn payout_overflow_guarded() {
        // a payout that can't fit u64 must Err at the try_into, never wrap or panic.
        assert!(redeem_payout(u64::MAX, u64::MAX, 1).is_err());
    }

    // ---- staking reward accumulator (acc_add / pending_reward) ----

    #[test]
    fn acc_add_basic_distribution() {
        // 1000 reward across 100 staked → acc = 1000·1e12/100 = 1e13.
        assert_eq!(acc_add(0, 1000, 100).unwrap(), 10_000_000_000_000);
    }

    #[test]
    fn acc_add_noop_when_nothing_staked() {
        // rewards arriving with 0 staked don't move the accumulator — they wait for a staker.
        assert_eq!(acc_add(5, 1000, 0).unwrap(), 5);
    }

    #[test]
    fn acc_add_noop_when_no_reward() {
        assert_eq!(acc_add(42, 0, 100).unwrap(), 42);
    }

    #[test]
    fn pending_zero_before_any_accrual() {
        assert_eq!(pending_reward(100, 0, 0).unwrap(), 0);
    }

    #[test]
    fn pending_sole_staker_earns_all() {
        let acc = acc_add(0, 1000, 100).unwrap();
        assert_eq!(pending_reward(100, acc, 0).unwrap(), 1000);
    }

    #[test]
    fn pending_splits_proportionally() {
        // stakers 100 and 300 (total 400), 800 reward → 200 / 600, fully distributed, no leak.
        let acc = acc_add(0, 800, 400).unwrap();
        let a = pending_reward(100, acc, 0).unwrap();
        let b = pending_reward(300, acc, 0).unwrap();
        assert_eq!((a, b, a + b), (200, 600, 800));
    }

    #[test]
    fn pending_excludes_pre_stake_rewards() {
        // a joiner's reward_debt is set to amount·acc/PRECISION at stake time (100·2e12/1e12 = 200),
        // so pending starts at 0 — they can't claim rewards that accrued before they joined.
        let acc = acc_add(0, 800, 400).unwrap(); // 2e12
        assert_eq!(pending_reward(100, acc, 200).unwrap(), 0);
    }

    #[test]
    fn acc_add_overflow_guarded() {
        assert!(acc_add(u128::MAX - 1, u64::MAX, 1).is_err());
    }

    #[test]
    fn pending_overflow_guarded() {
        assert!(pending_reward(u64::MAX, u128::MAX, 0).is_err());
    }

    // ---- jackpot ----
    #[test]
    fn winning_ticket_reduces_mod_total() {
        let mut r = [0u8; 32];
        r[..8].copy_from_slice(&1005u64.to_le_bytes());
        assert_eq!(winning_ticket(&r, 1000).unwrap(), 5);
        assert_eq!(winning_ticket(&r, 1006).unwrap(), 1005);
        assert!(winning_ticket(&r, 0).is_err());
    }

    #[test]
    fn ticket_range_boundaries() {
        assert!(ticket_in_range(10, 10, 5).unwrap()); // start inclusive
        assert!(ticket_in_range(14, 10, 5).unwrap()); // end - 1
        assert!(!ticket_in_range(15, 10, 5).unwrap()); // end exclusive
        assert!(!ticket_in_range(9, 10, 5).unwrap()); // below range
        assert!(ticket_in_range(u64::MAX, u64::MAX, u64::MAX).is_err()); // overflow guarded
    }

    #[test]
    fn merkle_verify_three_leaves_and_rejections() {
        let a = Pubkey::new_from_array([1u8; 32]);
        let b = Pubkey::new_from_array([2u8; 32]);
        let c = Pubkey::new_from_array([3u8; 32]);
        let la = hash_leaf(&a, 0, 10);
        let lb = hash_leaf(&b, 10, 20);
        let lc = hash_leaf(&c, 30, 5);
        let ab = hash_node(la, lb);
        let root = hash_node(ab, lc);
        // valid proofs for each leaf
        assert!(verify_merkle(&[lb, lc], &root, la));
        assert!(verify_merkle(&[la, lc], &root, lb));
        assert!(verify_merkle(&[ab], &root, lc));
        // wrong proof for a real leaf fails
        assert!(!verify_merkle(&[la, lc], &root, la));
        // tampered leaf (different tickets) fails
        assert!(!verify_merkle(&[lb, lc], &root, hash_leaf(&a, 0, 11)));
        // empty proof only verifies a single-leaf root
        assert!(verify_merkle(&[], &la, la));
        assert!(!verify_merkle(&[], &root, la));
    }
}

// ------------------------------- Accounts -------------------------------

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// The launched Solum token mint this vault backs.
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, token_mint.key().as_ref(), admin.key().as_ref()],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// CHECK: data-less PDA that owns the vault's stock token accounts and signs transfers.
    /// Bound to (token_mint, admin) so a vault is uniquely the creator's — no one can
    /// front-run init and hijack the treasury address for a coin.
    #[account(seeds = [VAULT_SEED, token_mint.key().as_ref(), admin.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub config: Account<'info, VaultConfig>,

    #[account(mut, address = config.token_mint @ SolumError::WrongMint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: vault PDA signer; derived from the config's (token_mint, admin) + stored bump.
    #[account(
        seeds = [VAULT_SEED, config.token_mint.as_ref(), config.admin.as_ref()],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub redeemer: Signer<'info>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = redeemer,
        token::token_program = token_program,
    )]
    pub redeemer_token_account: InterfaceAccount<'info, TokenAccount>,

    /// Token program of the redeemed coin (classic SPL for a pump.fun launch). Burns here.
    pub token_program: Interface<'info, TokenInterface>,
    /// Token program of the backing stock (Token-2022 for xStocks). Stock transfers here.
    pub stock_token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: [stock_mint, vault_ata, user_ata] * stock_count, in allowlist order.
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, has_one = admin @ SolumError::Unauthorized)]
    pub config: Account<'info, VaultConfig>,
    pub admin: Signer<'info>,
}

#[cfg(feature = "devnet-oracle")]
#[derive(Accounts)]
pub struct SetPrice<'info> {
    #[account(has_one = admin @ SolumError::Unauthorized)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [PRICE_SEED, config.key().as_ref(), stock_mint.key().as_ref()],
        bump
    )]
    pub price_feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "pyth-oracle")]
#[derive(Accounts)]
pub struct SetFeed<'info> {
    #[account(has_one = admin @ SolumError::Unauthorized)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + StockOracle::INIT_SPACE,
        seeds = [ORACLE_SEED, config.key().as_ref(), stock_mint.key().as_ref()],
        bump
    )]
    pub stock_oracle: Account<'info, StockOracle>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddBacking<'info> {
    #[account(has_one = engine @ SolumError::Unauthorized)]
    pub config: Account<'info, VaultConfig>,

    pub engine: Signer<'info>,

    /// CHECK: vault PDA signer; derived from the config's (token_mint, admin) + stored bump.
    #[account(
        seeds = [VAULT_SEED, config.token_mint.as_ref(), config.admin.as_ref()],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub funding_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub stock_vault: InterfaceAccount<'info, TokenAccount>,

    pub stock_mint: InterfaceAccount<'info, Mint>,

    /// The vault's pinned funding asset — `add_backing` may only ever spend this, never a stock.
    #[account(address = config.funding_mint @ SolumError::WrongMint)]
    pub funding_mint: InterfaceAccount<'info, Mint>,

    /// Oracle source (feature-gated). devnet: admin-published PriceFeed. pyth: per-vault feed-id
    /// binding (StockOracle) + the Pyth pull-oracle PriceUpdateV2.
    #[cfg(feature = "devnet-oracle")]
    #[account(seeds = [PRICE_SEED, config.key().as_ref(), stock_mint.key().as_ref()], bump)]
    pub price_feed: Account<'info, PriceFeed>,
    #[cfg(feature = "pyth-oracle")]
    #[account(seeds = [ORACLE_SEED, config.key().as_ref(), stock_mint.key().as_ref()], bump)]
    pub stock_oracle: Account<'info, StockOracle>,
    #[cfg(feature = "pyth-oracle")]
    pub price_update: Account<'info, pyth_solana_receiver_sdk::price_update::PriceUpdateV2>,

    /// CHECK: must equal config.swap_venue (checked in handler); invoked via CPI.
    pub swap_venue: UncheckedAccount<'info>,
    // remaining_accounts: the venue's own pool accounts for the swap.
}

#[derive(Accounts)]
pub struct HarvestFees<'info> {
    pub config: Account<'info, VaultConfig>,

    #[account(mut, address = config.token_mint @ SolumError::WrongMint)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    /// CHECK: transfer-fee withdraw authority PDA; validated by seeds, signs the withdraw.
    #[account(seeds = [FEE_SEED, token_mint.key().as_ref()], bump)]
    pub fee_authority: UncheckedAccount<'info>,

    /// CHECK: vault authority PDA that owns fee_vault; derived from (token_mint, admin).
    #[account(
        seeds = [VAULT_SEED, config.token_mint.as_ref(), config.admin.as_ref()],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub fee_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(address = spl_token_2022::ID @ SolumError::WrongMint)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct DepositStock<'info> {
    pub config: Account<'info, VaultConfig>,

    /// CHECK: vault authority PDA that owns stock_vault; derived from (token_mint, admin).
    #[account(
        seeds = [VAULT_SEED, config.token_mint.as_ref(), config.admin.as_ref()],
        bump = config.vault_authority_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub stock_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(mut)]
    pub depositor_stock_account: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub stock_vault: InterfaceAccount<'info, TokenAccount>,

    pub stock_token_program: Interface<'info, TokenInterface>,
}

// ------------------------------- State -------------------------------

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub token_mint: Pubkey,
    pub admin: Pubkey,
    pub engine: Pubkey,
    pub swap_venue: Pubkey,
    /// The one asset `add_backing` may spend (e.g. wSOL/USDC). Pinned at init; never a stock.
    pub funding_mint: Pubkey,
    pub backing_fee_bps: u16,
    pub max_slippage_bps: u16,
    pub paused: bool,
    pub stock_count: u8,
    pub vault_authority_bump: u8,
    pub config_bump: u8,
    pub stock_allowlist: [Pubkey; MAX_STOCKS],
    /// Forward-compat padding so a future upgrade can add fields without a migration.
    pub reserved: [u8; 128],
}

#[derive(Accounts)]
pub struct InitStakePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub coin_mint: InterfaceAccount<'info, Mint>,
    pub reward_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + StakePool::INIT_SPACE,
        seeds = [STAKE_SEED, coin_mint.key().as_ref(), admin.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, StakePool>,
    /// CHECK: stake-authority PDA that owns the custody + reward vault; bump captured here.
    #[account(seeds = [STAKE_AUTH_SEED, pool.key().as_ref()], bump)]
    pub stake_authority: UncheckedAccount<'info>,
    #[account(
        constraint = staked_custody.owner == stake_authority.key() @ SolumError::BadCustodyOwner,
        constraint = staked_custody.mint == coin_mint.key() @ SolumError::WrongMint,
    )]
    pub staked_custody: InterfaceAccount<'info, TokenAccount>,
    #[account(
        constraint = reward_vault.owner == stake_authority.key() @ SolumError::BadCustodyOwner,
        constraint = reward_vault.mint == reward_mint.key() @ SolumError::WrongRewardMint,
    )]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SyncRewards<'info> {
    #[account(
        mut,
        seeds = [STAKE_SEED, pool.coin_mint.as_ref(), pool.admin.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,
    #[account(address = pool.reward_vault @ SolumError::WrongRewardMint)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [STAKE_SEED, pool.coin_mint.as_ref(), pool.admin.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,
    /// CHECK: stake-authority PDA.
    #[account(seeds = [STAKE_AUTH_SEED, pool.key().as_ref()], bump = pool.stake_authority_bump)]
    pub stake_authority: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + StakeAccount::INIT_SPACE,
        seeds = [STAKE_ACCT_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(address = pool.coin_mint @ SolumError::WrongMint)]
    pub coin_mint: InterfaceAccount<'info, Mint>,
    #[account(address = pool.reward_mint @ SolumError::WrongRewardMint)]
    pub reward_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner_coin_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub owner_reward_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.staked_custody @ SolumError::BadCustodyOwner)]
    pub staked_custody: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.reward_vault @ SolumError::WrongRewardMint)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub coin_token_program: Interface<'info, TokenInterface>,
    pub reward_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimReward<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [STAKE_SEED, pool.coin_mint.as_ref(), pool.admin.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,
    /// CHECK: stake-authority PDA.
    #[account(seeds = [STAKE_AUTH_SEED, pool.key().as_ref()], bump = pool.stake_authority_bump)]
    pub stake_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [STAKE_ACCT_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = stake_account.bump,
        has_one = owner @ SolumError::Unauthorized
    )]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(address = pool.reward_mint @ SolumError::WrongRewardMint)]
    pub reward_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner_reward_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.reward_vault @ SolumError::WrongRewardMint)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub reward_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [STAKE_SEED, pool.coin_mint.as_ref(), pool.admin.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, StakePool>,
    /// CHECK: stake-authority PDA.
    #[account(seeds = [STAKE_AUTH_SEED, pool.key().as_ref()], bump = pool.stake_authority_bump)]
    pub stake_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [STAKE_ACCT_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = stake_account.bump,
        has_one = owner @ SolumError::Unauthorized
    )]
    pub stake_account: Account<'info, StakeAccount>,
    #[account(address = pool.coin_mint @ SolumError::WrongMint)]
    pub coin_mint: InterfaceAccount<'info, Mint>,
    #[account(address = pool.reward_mint @ SolumError::WrongRewardMint)]
    pub reward_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner_coin_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub owner_reward_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.staked_custody @ SolumError::BadCustodyOwner)]
    pub staked_custody: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, address = pool.reward_vault @ SolumError::WrongRewardMint)]
    pub reward_vault: InterfaceAccount<'info, TokenAccount>,
    pub coin_token_program: Interface<'info, TokenInterface>,
    pub reward_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitJackpot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub coin_mint: InterfaceAccount<'info, Mint>,
    pub prize_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: address allowed to commit epoch roots (the off-chain snapshotter).
    pub snapshotter: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + JackpotState::INIT_SPACE,
        seeds = [JACKPOT_SEED, coin_mint.key().as_ref(), admin.key().as_ref()],
        bump
    )]
    pub jackpot: Account<'info, JackpotState>,
    /// CHECK: jackpot authority PDA that owns the pot custody (no private key).
    #[account(seeds = [JACKPOT_AUTH_SEED, jackpot.key().as_ref()], bump)]
    pub jackpot_authority: UncheckedAccount<'info>,
    /// Prize pot: a prize_mint token account owned by the jackpot authority PDA.
    #[account(token::mint = prize_mint, token::authority = jackpot_authority)]
    pub pot_custody: InterfaceAccount<'info, TokenAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CommitEpoch<'info> {
    pub snapshotter: Signer<'info>,
    #[account(
        mut,
        seeds = [JACKPOT_SEED, jackpot.coin_mint.as_ref(), jackpot.admin.as_ref()],
        bump = jackpot.bump,
        has_one = snapshotter @ SolumError::Unauthorized
    )]
    pub jackpot: Account<'info, JackpotState>,
}

#[cfg(all(feature = "devnet-vrf", not(feature = "switchboard-vrf")))]
#[derive(Accounts)]
pub struct SettleDraw<'info> {
    pub snapshotter: Signer<'info>,
    #[account(
        mut,
        seeds = [JACKPOT_SEED, jackpot.coin_mint.as_ref(), jackpot.admin.as_ref()],
        bump = jackpot.bump,
        has_one = snapshotter @ SolumError::Unauthorized
    )]
    pub jackpot: Account<'info, JackpotState>,
}

#[cfg(feature = "switchboard-vrf")]
#[derive(Accounts)]
pub struct RequestDraw<'info> {
    pub caller: Signer<'info>, // permissionless
    #[account(
        mut,
        seeds = [JACKPOT_SEED, jackpot.coin_mint.as_ref(), jackpot.admin.as_ref()],
        bump = jackpot.bump
    )]
    pub jackpot: Account<'info, JackpotState>,
    /// CHECK: Switchboard On-Demand randomness account; parsed + validated by RandomnessAccountData.
    pub randomness: UncheckedAccount<'info>,
}

#[cfg(feature = "switchboard-vrf")]
#[derive(Accounts)]
pub struct SettleDrawVrf<'info> {
    pub caller: Signer<'info>, // permissionless
    #[account(
        mut,
        seeds = [JACKPOT_SEED, jackpot.coin_mint.as_ref(), jackpot.admin.as_ref()],
        bump = jackpot.bump
    )]
    pub jackpot: Account<'info, JackpotState>,
    /// CHECK: must equal jackpot.randomness_account (checked in the handler).
    pub randomness: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ClaimPrize<'info> {
    /// Permissionless — anyone (e.g. the draw bot) may pay out; funds can only ever reach the
    /// proven winner's own account, so there is nothing to steal by triggering it.
    pub caller: Signer<'info>,
    /// CHECK: the winning holder — the `owner` in the winning leaf, and the recipient of the pot.
    /// Not a signer; the payout address is pinned by `winner_prize_account`'s authority below.
    pub winner: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [JACKPOT_SEED, jackpot.coin_mint.as_ref(), jackpot.admin.as_ref()],
        bump = jackpot.bump
    )]
    pub jackpot: Account<'info, JackpotState>,
    /// CHECK: jackpot authority PDA (owns the pot custody).
    #[account(
        seeds = [JACKPOT_AUTH_SEED, jackpot.key().as_ref()],
        bump = jackpot.jackpot_authority_bump
    )]
    pub jackpot_authority: UncheckedAccount<'info>,
    #[account(address = jackpot.prize_mint @ SolumError::WrongMint)]
    pub prize_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = jackpot.pot_custody @ SolumError::BadVaultOwner)]
    pub pot_custody: InterfaceAccount<'info, TokenAccount>,
    /// The winner's own prize account — `token::authority = winner` forces the pot to the winner.
    #[account(mut, token::authority = winner)]
    pub winner_prize_account: InterfaceAccount<'info, TokenAccount>,
    pub prize_token_program: Interface<'info, TokenInterface>,
}

/// Stake-to-earn pool for a coin, rewarding stakers in one allowlisted stock via a MasterChef
/// reward-per-share accumulator. See docs/STAKING.md.
#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub coin_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub admin: Pubkey,
    /// Token account (coin_mint) owned by the stake authority — holds all staked coins.
    pub staked_custody: Pubkey,
    /// Token account (reward_mint) owned by the stake authority — holds reward stock to distribute.
    pub reward_vault: Pubkey,
    pub total_staked: u64,
    pub acc_reward_per_share: u128,
    pub last_reward_balance: u64,
    pub stake_authority_bump: u8,
    pub bump: u8,
    pub reserved: [u8; 64],
}

/// One staker's position in a `StakePool`.
#[account]
#[derive(InitSpace)]
pub struct StakeAccount {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub reward_debt: u128,
    pub bump: u8,
}

/// No-loss real-stock jackpot for a coin. Fees fund a prize pot; each epoch a TWAB-weighted holder
/// is drawn from a snapshotter-committed Merkle root using verifiable randomness. See docs/JACKPOT.md.
#[account]
#[derive(InitSpace)]
pub struct JackpotState {
    pub coin_mint: Pubkey,
    pub prize_mint: Pubkey,
    pub admin: Pubkey,
    /// Address allowed to commit epoch TWAB roots (the off-chain snapshotter).
    pub snapshotter: Pubkey,
    /// prize_mint token account owned by the jackpot authority PDA — holds the pot. No withdraw path.
    pub pot_custody: Pubkey,
    pub epoch_len: i64,
    pub current_epoch: u64,
    pub epoch_start: i64,
    /// Merkle root of the committed epoch's `(owner, ticket_start, tickets)` leaves.
    pub twab_root: [u8; 32],
    pub total_tickets: u64,
    pub winning_ticket: u64,
    /// 0 = Open, 1 = Committed, 2 = Settled, 3 = Requested (switchboard-vrf).
    pub phase: u8,
    pub jackpot_authority_bump: u8,
    pub bump: u8,
    /// [switchboard-vrf] the randomness account bound at request_draw, and the slot it committed to.
    pub randomness_account: Pubkey,
    pub commit_slot: u64,
    pub reserved: [u8; 24],
}

#[cfg(feature = "devnet-oracle")]
#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub stock_mint: Pubkey,
    /// Price of one whole stock in whole funding-asset units, scaled by 10^expo (expo <= 0).
    pub price: u64,
    pub expo: i32,
    pub publish_slot: u64,
}

/// Per-vault, per-stock binding to a Pyth price-feed id. The admin only points at a feed
/// (via `set_feed`); it never publishes a price. pyth-oracle feature.
#[cfg(feature = "pyth-oracle")]
#[account]
#[derive(InitSpace)]
pub struct StockOracle {
    pub stock_mint: Pubkey,
    /// Pyth price-feed id for STOCK / <funding unit> (32 bytes).
    pub feed_id: [u8; 32],
}

// ------------------------------- Events -------------------------------

#[event]
pub struct VaultInitialized {
    pub token_mint: Pubkey,
    pub admin: Pubkey,
    pub engine: Pubkey,
    pub swap_venue: Pubkey,
    pub backing_fee_bps: u16,
    pub stock_count: u8,
}

#[event]
pub struct Redeemed {
    pub token_mint: Pubkey,
    pub redeemer: Pubkey,
    pub amount: u64,
    pub supply_before: u64,
}

#[event]
pub struct ParamsUpdated {
    pub token_mint: Pubkey,
    pub field: String,
}

#[cfg(feature = "devnet-oracle")]
#[event]
pub struct PriceSet {
    pub stock_mint: Pubkey,
    pub price: u64,
    pub expo: i32,
    pub slot: u64,
}

#[cfg(feature = "pyth-oracle")]
#[event]
pub struct FeedSet {
    pub stock_mint: Pubkey,
    pub feed_id: [u8; 32],
}

#[event]
pub struct Backed {
    pub token_mint: Pubkey,
    pub stock_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct FeesHarvested {
    pub token_mint: Pubkey,
    pub fee_vault: Pubkey,
    pub balance: u64,
}

#[event]
pub struct BackingDeposited {
    pub token_mint: Pubkey,
    pub stock_mint: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct StakePoolInitialized {
    pub coin_mint: Pubkey,
    pub reward_mint: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct Staked {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub total: u64,
}

#[event]
pub struct Unstaked {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub total: u64,
}

#[event]
pub struct RewardClaimed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct JackpotInitialized {
    pub jackpot: Pubkey,
    pub coin_mint: Pubkey,
    pub prize_mint: Pubkey,
}

#[event]
pub struct EpochCommitted {
    pub jackpot: Pubkey,
    pub epoch: u64,
    pub total_tickets: u64,
}

#[event]
pub struct DrawRequested {
    pub jackpot: Pubkey,
    pub epoch: u64,
    pub commit_slot: u64,
}

#[event]
pub struct DrawSettled {
    pub jackpot: Pubkey,
    pub epoch: u64,
    pub winning_ticket: u64,
}

#[event]
pub struct PrizeClaimed {
    pub jackpot: Pubkey,
    pub epoch: u64,
    pub winner: Pubkey,
    pub amount: u64,
}

// ------------------------------- Errors -------------------------------

#[error_code]
pub enum SolumError {
    #[msg("Backing fee exceeds the hard cap")]
    FeeTooHigh,
    #[msg("Allowlist must contain at least one stock")]
    NoStocks,
    #[msg("Too many stocks for this vault")]
    TooManyStocks,
    #[msg("Stock mint may not be the default pubkey")]
    InvalidStock,
    #[msg("Duplicate stock in allowlist")]
    DuplicateStock,
    #[msg("Funding mint may not also be a backing stock")]
    FundingIsStock,
    #[msg("Engine authority may not be the default pubkey")]
    InvalidEngine,
    #[msg("Swap venue may not be the default pubkey")]
    InvalidVenue,
    #[msg("Vault is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Token supply is zero")]
    EmptySupply,
    #[msg("Redeem amount exceeds total supply")]
    AmountExceedsSupply,
    #[msg("remaining_accounts must be exactly stock_count triples")]
    BadRemainingAccounts,
    #[msg("Provided stock mint does not match the allowlist at this index")]
    StockMismatch,
    #[msg("Source account is not owned by the vault authority")]
    BadVaultOwner,
    #[msg("Mint account does not match the vault's token mint")]
    WrongMint,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Signer is not the admin")]
    Unauthorized,
    #[msg("Slippage tolerance exceeds the hard cap")]
    SlippageTooHigh,
    #[msg("Swap venue does not match the allowlisted venue")]
    WrongVenue,
    #[msg("Oracle price is stale")]
    StaleOracle,
    #[msg("Oracle price is invalid")]
    BadOracle,
    #[msg("Funding account has insufficient balance")]
    InsufficientFunding,
    #[msg("Funding balance increased during backing")]
    FundingIncreased,
    #[msg("Swap spent more than the permitted amount")]
    OverSpend,
    #[msg("Stock balance decreased during backing")]
    StockDecreased,
    #[msg("Backing delivered less stock than the oracle floor")]
    InsufficientBacking,
    #[msg("Venue tampered with a vault account (delegate/authority)")]
    VenueTampered,
    #[msg("Stake account has insufficient staked balance")]
    InsufficientStake,
    #[msg("Reward vault mint does not match the pool reward mint")]
    WrongRewardMint,
    #[msg("Custody account is not owned by the stake authority")]
    BadCustodyOwner,
    #[msg("Jackpot is not in the open phase")]
    JackpotBusy,
    #[msg("Jackpot draw is not in the required phase")]
    JackpotNotReady,
    #[msg("The epoch has not elapsed yet")]
    EpochNotElapsed,
    #[msg("Merkle proof is invalid")]
    BadProof,
    #[msg("Signer does not hold the winning ticket")]
    NotWinner,
}
