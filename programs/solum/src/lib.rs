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
    program::invoke_signed,
};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::{
    self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked,
};

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

#[cfg(test)]
mod tests {
    use super::{min_out_floor, redeem_payout};

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
}
