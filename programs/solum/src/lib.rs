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

/// Oracle price is rejected if older than this many slots (~2 min at 400ms/slot).
pub const MAX_PRICE_STALENESS_SLOTS: u64 = 300;

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";
pub const PRICE_SEED: &[u8] = b"price";
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

            // payout = amount * vault_balance / supply_before  (u128, round down)
            let payout: u64 = (amount as u128)
                .checked_mul(vault_ata.amount as u128)
                .ok_or(SolumError::MathOverflow)?
                .checked_div(supply_before as u128)
                .ok_or(SolumError::MathOverflow)?
                .try_into()
                .map_err(|_| SolumError::MathOverflow)?;

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

    /// Publish a stock price to the per-stock PriceFeed PDA. Admin-signed. This is the DEVNET
    /// oracle stand-in — in production the min-out floor reads a Pyth price account instead;
    /// the `add_backing` guard is identical, only the price source changes.
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

        // Oracle freshness + sanity (price_feed PDA binding is enforced by the accounts struct).
        let pf = &ctx.accounts.price_feed;
        let slot = Clock::get()?.slot;
        require!(slot.saturating_sub(pf.publish_slot) <= MAX_PRICE_STALENESS_SLOTS, SolumError::StaleOracle);
        require!(pf.price > 0 && pf.expo <= 0, SolumError::BadOracle);

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

        // fair_out_base = actual_in * 10^stock_dec * 10^(-expo) / (10^quote_dec * price)
        let sd = ctx.accounts.stock_mint.decimals as u32;
        let qd = ctx.accounts.funding_mint.decimals as u32;
        let pe = (-pf.expo) as u32;
        let num = (actual_in as u128)
            .checked_mul(pow10(sd)?).ok_or(SolumError::MathOverflow)?
            .checked_mul(pow10(pe)?).ok_or(SolumError::MathOverflow)?;
        let den = pow10(qd)?.checked_mul(pf.price as u128).ok_or(SolumError::MathOverflow)?;
        let fair_out = num.checked_div(den).ok_or(SolumError::MathOverflow)?;
        let floor = fair_out
            .checked_mul((10_000 - cfg.max_slippage_bps) as u128).ok_or(SolumError::MathOverflow)?
            .checked_div(10_000).ok_or(SolumError::MathOverflow)?;
        // Reject dust: if the oracle floor rounds to zero, a near-zero fill would pass and let
        // funding trickle out for nothing. Every spend must buy a nonzero, oracle-justified amount.
        require!(floor > 0, SolumError::InsufficientBacking);
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

    /// Per-vault, per-stock price feed; binding to (config, stock_mint) enforced here.
    #[account(seeds = [PRICE_SEED, config.key().as_ref(), stock_mint.key().as_ref()], bump)]
    pub price_feed: Account<'info, PriceFeed>,

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

#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub stock_mint: Pubkey,
    /// Price of one whole stock in whole funding-asset units, scaled by 10^expo (expo <= 0).
    pub price: u64,
    pub expo: i32,
    pub publish_slot: u64,
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

#[event]
pub struct PriceSet {
    pub stock_mint: Pubkey,
    pub price: u64,
    pub expo: i32,
    pub slot: u64,
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
