// =============================================================================
// instructions/initialize_epoch_config.rs — One-time epoch schedule setup
// =============================================================================
//
// Called once by the protocol admin to define the epoch schedule.
// Epoch vaults must expire on the configured day and hour.
//
// Default configuration:
//   - Day: Friday (5)
//   - Hour: 08:00 UTC (8)
//   - Monthly: enabled
//   - Min duration: 1 day
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::*;

pub fn handle_initialize_epoch_config(
    ctx: Context<InitializeEpochConfig>,
    weekly_expiry_day: u8,
    weekly_expiry_hour: u8,
    monthly_enabled: bool,
) -> Result<()> {
    // Validate day of week: 0=Sunday through 6=Saturday
    require!(weekly_expiry_day <= 6, OptaError::InvalidEpochExpiry);
    // Validate hour: 0-23
    require!(weekly_expiry_hour <= 23, OptaError::InvalidEpochExpiry);

    let config = &mut ctx.accounts.epoch_config;
    config.authority = ctx.accounts.admin.key();
    config.weekly_expiry_day = weekly_expiry_day;
    config.weekly_expiry_hour = weekly_expiry_hour;
    config.monthly_enabled = monthly_enabled;
    config.min_epoch_duration_days = 1; // sensible default
    config.bump = ctx.bumps.epoch_config;

    Ok(())
}

#[derive(Accounts)]
pub struct InitializeEpochConfig<'info> {
    /// Protocol admin — must match protocol_state.admin.
    #[account(
        mut,
        constraint = admin.key() == protocol_state.admin @ OptaError::Unauthorized,
    )]
    pub admin: Signer<'info>,

    /// Protocol state — used to verify the admin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The epoch config PDA — created once, never recreated.
    #[account(
        init,
        seeds = [EPOCH_CONFIG_SEED],
        bump,
        payer = admin,
        space = 8 + EpochConfig::INIT_SPACE,
    )]
    pub epoch_config: Account<'info, EpochConfig>,

    pub system_program: Program<'info, System>,
}
