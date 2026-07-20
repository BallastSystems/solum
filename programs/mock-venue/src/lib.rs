//! TEST-ONLY mock swap venue. A minimal constant-rate "AMM" implementing the Ballast Venue
//! ABI v1 `swap(amount_in)` so the main program's `add_backing` net-effect guard can be
//! exercised: a fair fill passes, a shortchange or no-op fill is rejected by the vault.
//! Not part of the protocol; never deployed to mainnet.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("8ydnEbnYJgLGKhA6CoeF1xhxaxqk8a8AoDGvtXJ14Nq5");

pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_AUTH_SEED: &[u8] = b"pool-auth";

#[program]
pub mod mock_venue {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>, rate_num: u64, rate_den: u64) -> Result<()> {
        require!(rate_den > 0, MockError::BadRate);
        let pool = &mut ctx.accounts.pool;
        pool.funding_mint = ctx.accounts.funding_mint.key();
        pool.stock_mint = ctx.accounts.stock_mint.key();
        pool.rate_num = rate_num;
        pool.rate_den = rate_den;
        pool.authority_bump = ctx.bumps.pool_authority;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Adjust the fill rate — lets a test flip a pool between fair and shortchange fills.
    pub fn set_rate(ctx: Context<SetRate>, rate_num: u64, rate_den: u64) -> Result<()> {
        require!(rate_den > 0, MockError::BadRate);
        ctx.accounts.pool.rate_num = rate_num;
        ctx.accounts.pool.rate_den = rate_den;
        Ok(())
    }

    /// Ballast Venue ABI v1. Fixed leading accounts (supplied by the caller program):
    ///   [vault_authority(signer), funding_vault(w), stock_vault(w)]
    /// then the venue's own pool accounts:
    ///   [pool, pool_funding(w), pool_stock(w), pool_authority, funding_mint, stock_mint, token_program]
    /// Pulls `amount_in` funding from the caller's vault, deposits `amount_in * rate` stock.
    pub fn swap(ctx: Context<Swap>, amount_in: u64) -> Result<()> {
        // Pull funding from the caller's vault (its authority signed the outer CPI).
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.funding_vault.to_account_info(),
                    mint: ctx.accounts.funding_mint.to_account_info(),
                    to: ctx.accounts.pool_funding.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
            ),
            amount_in,
            ctx.accounts.funding_mint.decimals,
        )?;

        let out: u64 = (amount_in as u128)
            .checked_mul(ctx.accounts.pool.rate_num as u128)
            .unwrap()
            .checked_div(ctx.accounts.pool.rate_den as u128)
            .unwrap()
            .try_into()
            .unwrap();

        // Deliver stock from the pool reserve (pool authority PDA signs).
        let fmint = ctx.accounts.pool.funding_mint;
        let smint = ctx.accounts.pool.stock_mint;
        let bump = ctx.accounts.pool.authority_bump;
        let seeds: &[&[&[u8]]] = &[&[POOL_AUTH_SEED, fmint.as_ref(), smint.as_ref(), &[bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.pool_stock.to_account_info(),
                    mint: ctx.accounts.stock_mint.to_account_info(),
                    to: ctx.accounts.stock_vault.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                seeds,
            ),
            out,
            ctx.accounts.stock_mint.decimals,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub funding_mint: InterfaceAccount<'info, Mint>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, funding_mint.key().as_ref(), stock_mint.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: PDA authority over the pool reserves.
    #[account(seeds = [POOL_AUTH_SEED, funding_mint.key().as_ref(), stock_mint.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRate<'info> {
    #[account(mut)]
    pub pool: Account<'info, Pool>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    /// CHECK: authority over funding_vault; its signature is passed through from the caller.
    pub vault_authority: Signer<'info>,
    #[account(mut)]
    pub funding_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub stock_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        seeds = [POOL_SEED, pool.funding_mint.as_ref(), pool.stock_mint.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub pool_funding: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub pool_stock: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: pool authority PDA; validated by seeds.
    #[account(
        seeds = [POOL_AUTH_SEED, pool.funding_mint.as_ref(), pool.stock_mint.as_ref()],
        bump = pool.authority_bump
    )]
    pub pool_authority: UncheckedAccount<'info>,
    pub funding_mint: InterfaceAccount<'info, Mint>,
    pub stock_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub funding_mint: Pubkey,
    pub stock_mint: Pubkey,
    pub rate_num: u64,
    pub rate_den: u64,
    pub authority_bump: u8,
    pub bump: u8,
}

#[error_code]
pub enum MockError {
    #[msg("rate denominator must be nonzero")]
    BadRate,
}
