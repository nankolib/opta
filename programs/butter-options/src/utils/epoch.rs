// =============================================================================
// utils/epoch.rs — Epoch expiry validation and calculation
// =============================================================================
//
// Epoch vaults must expire on a specific day of the week (default: Friday)
// at a specific hour (default: 08:00 UTC). These functions validate and
// compute epoch expiry timestamps.
//
// Day of week convention: 0=Sunday, 1=Monday, ... 5=Friday, 6=Saturday
// This matches the traditional options market where weekly options expire
// on Fridays.
// =============================================================================

use crate::state::EpochConfig;

/// Seconds per day.
const SECONDS_PER_DAY: i64 = 86400;
/// Seconds per hour.
const SECONDS_PER_HOUR: i64 = 3600;
/// Seconds per minute.
const SECONDS_PER_MINUTE: i64 = 60;

/// Check whether a unix timestamp falls exactly on a valid epoch boundary.
///
/// A valid epoch expiry must be:
///   - On the configured day of the week (e.g., Friday = 5)
///   - At the configured hour (e.g., 08:00 UTC)
///   - Exactly on the hour (minute = 0, second = 0)
///
/// Unix epoch (Jan 1, 1970 00:00 UTC) was a Thursday (day 4).
/// So: (timestamp / 86400 + 4) % 7 gives day of week (0=Sunday, 5=Friday).
pub fn is_valid_epoch_expiry(expiry: i64, config: &EpochConfig) -> bool {
    let days_since_epoch = expiry / SECONDS_PER_DAY;
    let day_of_week = ((days_since_epoch + 4) % 7) as u8; // 0=Sun, 5=Fri
    let hour_of_day = ((expiry % SECONDS_PER_DAY) / SECONDS_PER_HOUR) as u8;
    let minute = ((expiry % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE) as u8;
    let second = (expiry % SECONDS_PER_MINUTE) as u8;

    day_of_week == config.weekly_expiry_day
        && hour_of_day == config.weekly_expiry_hour
        && minute == 0
        && second == 0
}

/// Find the next valid epoch expiry timestamp after `from`.
///
/// Walks forward from the current time to the next occurrence of the
/// configured day + hour. If `from` is already past the target time
/// on the target day, rolls to the following week.
pub fn next_epoch_expiry(from: i64, config: &EpochConfig) -> i64 {
    let days_since_epoch = from / SECONDS_PER_DAY;
    let current_day_of_week = ((days_since_epoch + 4) % 7) as i64;
    let target_day = config.weekly_expiry_day as i64;

    // How many days until the next target day?
    let days_until = if current_day_of_week <= target_day {
        target_day - current_day_of_week
    } else {
        7 - current_day_of_week + target_day
    };

    // Target timestamp: start of target day + configured hour
    let target_timestamp = (days_since_epoch + days_until) * SECONDS_PER_DAY
        + (config.weekly_expiry_hour as i64) * SECONDS_PER_HOUR;

    // If we're already past the target time on the target day, go to next week
    if target_timestamp <= from {
        target_timestamp + 7 * SECONDS_PER_DAY
    } else {
        target_timestamp
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::EpochConfig;
    use anchor_lang::prelude::Pubkey;

    fn friday_config() -> EpochConfig {
        EpochConfig {
            authority: Pubkey::default(),
            weekly_expiry_day: 5,   // Friday
            weekly_expiry_hour: 8,  // 08:00 UTC
            monthly_enabled: true,
            min_epoch_duration_days: 1,
            bump: 0,
        }
    }

    #[test]
    fn test_valid_friday_expiry() {
        let config = friday_config();
        // Friday April 18, 2025 08:00 UTC = 1745049600 (verify: 2025-04-18 is a Friday)
        // Actually let's compute: April 18, 2025
        // Days from epoch to 2025-04-18: need to calculate
        // Let's use a known Friday: 2026-04-17 is a Friday
        // 2026-04-17 08:00 UTC:
        // Days from 1970-01-01 to 2026-04-17 = 20560 days
        // (20560 + 4) % 7 = 20564 % 7 = 2937*7 + 5 = 5 (Friday!)
        let friday_0800 = 20560i64 * 86400 + 8 * 3600; // 1776384000
        assert!(is_valid_epoch_expiry(friday_0800, &config));
    }

    #[test]
    fn test_invalid_non_friday() {
        let config = friday_config();
        // Saturday = Friday + 1 day
        let saturday_0800 = 20561i64 * 86400 + 8 * 3600;
        assert!(!is_valid_epoch_expiry(saturday_0800, &config));
    }

    #[test]
    fn test_invalid_wrong_hour() {
        let config = friday_config();
        // Friday at 09:00 instead of 08:00
        let friday_0900 = 20560i64 * 86400 + 9 * 3600;
        assert!(!is_valid_epoch_expiry(friday_0900, &config));
    }

    #[test]
    fn test_invalid_not_on_hour() {
        let config = friday_config();
        // Friday at 08:30
        let friday_0830 = 20560i64 * 86400 + 8 * 3600 + 30 * 60;
        assert!(!is_valid_epoch_expiry(friday_0830, &config));
    }

    #[test]
    fn test_next_epoch_from_monday() {
        let config = friday_config();
        // Monday at noon
        let monday = 20557i64 * 86400 + 12 * 3600; // Mon 2026-04-14 12:00 (if day 20557 is Monday)
        let next = next_epoch_expiry(monday, &config);
        assert!(is_valid_epoch_expiry(next, &config));
        assert!(next > monday);
    }
}
