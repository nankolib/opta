// =============================================================================
// events.rs — On-chain events emitted by Butter Options
// =============================================================================

use anchor_lang::prelude::*;

#[event]
pub struct OptionWritten {
    pub market: Pubkey,
    pub writer: Pubkey,
    pub position: Pubkey,
    pub option_mint: Pubkey,
    pub premium: u64,
    pub collateral: u64,
    pub contract_size: u64,
}

#[event]
pub struct OptionPurchased {
    pub market: Pubkey,
    pub position: Pubkey,
    pub buyer: Pubkey,
    pub premium: u64,
    pub fee: u64,
}

#[event]
pub struct OptionExercised {
    pub position: Pubkey,
    pub exerciser: Pubkey,
    pub settlement_price: u64,
    pub pnl: u64,
    pub tokens_burned: u64,
    pub profitable: bool,
}

#[event]
pub struct OptionExpired {
    pub position: Pubkey,
}

#[event]
pub struct OptionCancelled {
    pub position: Pubkey,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub settlement_price: u64,
}

#[event]
pub struct OptionListedForResale {
    pub position: Pubkey,
    pub seller: Pubkey,
    pub resale_premium: u64,
}

#[event]
pub struct OptionResold {
    pub position: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub resale_premium: u64,
    pub fee: u64,
}

#[event]
pub struct ResaleCancelled {
    pub position: Pubkey,
    pub seller: Pubkey,
}
