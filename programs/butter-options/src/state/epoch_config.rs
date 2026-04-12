// =============================================================================
// state/epoch_config.rs — Global epoch schedule configuration
// =============================================================================
//
// Stores the protocol's epoch schedule — which day of the week and hour
// options expire on. Epoch vaults must align to this schedule.
//
// Default: Fridays at 08:00 UTC (matching traditional options expiry).
//
// PDA seed: ["epoch_config"]
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EpochConfig {
    /// Who can modify the epoch schedule (protocol admin).
    pub authority: Pubkey,

    /// Day of week for weekly expiries. 0 = Sunday, 5 = Friday, 6 = Saturday.
    pub weekly_expiry_day: u8,

    /// Hour (UTC, 0-23) for weekly expiries. Default 8 = 08:00 UTC.
    pub weekly_expiry_hour: u8,

    /// Whether the last Friday of each month has a separate monthly epoch.
    pub monthly_enabled: bool,

    /// Minimum days to expiry for new epoch vaults (e.g., 1 day).
    /// Prevents creating vaults that expire too soon.
    pub min_epoch_duration_days: u8,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for the EpochConfig singleton.
pub const EPOCH_CONFIG_SEED: &[u8] = b"epoch_config";
