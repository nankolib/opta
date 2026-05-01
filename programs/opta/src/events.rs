// =============================================================================
// events.rs — On-chain events emitted by Opta
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

// =============================================================================
// Shared Vault events (v2 liquidity system)
// =============================================================================

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub market: Pubkey,
    pub vault_type: u8,
    pub strike_price: u64,
    pub expiry: i64,
    pub option_type: u8,
    pub creator: Pubkey,
}

#[event]
pub struct VaultDeposited {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub total_collateral: u64,
}

#[event]
pub struct VaultMinted {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub mint: Pubkey,
    pub quantity: u64,
    pub premium_per_contract: u64,
}

#[event]
pub struct VaultPurchased {
    pub vault: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub quantity: u64,
    pub total_premium: u64,
}

#[event]
pub struct VaultBurnUnsold {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub mint: Pubkey,
    pub burned: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct PremiumClaimed {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultSettled {
    pub vault: Pubkey,
    pub settlement_price: u64,
    pub total_payout: u64,
    pub collateral_remaining: u64,
}

#[event]
pub struct VaultExercised {
    pub vault: Pubkey,
    pub holder: Pubkey,
    pub quantity: u64,
    pub payout: u64,
}

#[event]
pub struct VaultPostSettlementWithdraw {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct HoldersFinalized {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub holders_processed: u32,
    pub total_burned: u64,
    pub total_paid_out: u64,
}

#[event]
pub struct WritersFinalized {
    pub vault: Pubkey,
    pub writers_processed: u32,
    pub total_paid_out: u64,
    /// Non-zero only when this batch contained the last writer; otherwise 0.
    pub dust_swept_to_treasury: u64,
}

// =============================================================================
// V2 secondary listing events
// =============================================================================

#[event]
pub struct VaultListingCreated {
    pub listing: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub listed_quantity: u64,
    pub price_per_contract: u64,
    pub created_at: i64,
}

#[event]
pub struct VaultListingFilled {
    pub listing: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub quantity: u64,
    pub total_price: u64,
    pub fee: u64,
    pub listing_remaining: u64,
    pub listing_closed: bool,
}

#[event]
pub struct VaultListingCancelled {
    pub listing: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub returned_quantity: u64,
}

#[event]
pub struct VaultListingsAutoCancelled {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub listings_cancelled: u32,
    pub tokens_returned: u64,
}
