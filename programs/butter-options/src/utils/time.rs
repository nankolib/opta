// =============================================================================
// utils/time.rs — Shared date/time utilities
// =============================================================================
//
// FIX I-04: Deduplicate timestamp_to_month_day and is_leap_year from
// write_option.rs and mint_from_vault.rs into a shared module.
// =============================================================================

/// Convert a unix timestamp to (month_index 0-11, day 1-31).
/// Basic civil calendar math — no external crate needed.
pub fn timestamp_to_month_day(timestamp: i64) -> (usize, u8) {
    let total_days = timestamp / 86400;
    let mut year = 1970i64;
    let mut remaining = total_days;

    loop {
        let days_in_year = if is_leap_year(year) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        year += 1;
    }

    let days_in_months: [i64; 12] = if is_leap_year(year) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };

    let mut month = 0usize;
    for (i, &dim) in days_in_months.iter().enumerate() {
        if remaining < dim {
            month = i;
            break;
        }
        remaining -= dim;
    }

    (month, remaining as u8 + 1)
}

pub fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}
