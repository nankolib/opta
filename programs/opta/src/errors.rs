// =============================================================================
// errors.rs — Custom error codes for the Opta protocol
// =============================================================================
//
// Stage 2 prune: v1-only variants removed. New variants added for asset
// registry validation and (Stage 3) collateral mint validation.
// =============================================================================

use anchor_lang::prelude::*;

#[error_code]
pub enum OptaError {
    // Protocol errors
    #[msg("Unauthorized: signer is not the protocol admin")]
    Unauthorized,

    // Market / asset registry errors
    #[msg("Expiry timestamp must be in the future")]
    ExpiryInPast,
    #[msg("Strike price must be greater than zero")]
    InvalidStrikePrice,
    #[msg("Asset name must be 1-16 ASCII uppercase letters or digits")]
    InvalidAssetName,
    #[msg("Asset not in supported registry — contact protocol admin to add")]
    UnknownAsset,
    #[msg("Market already exists for this asset with different metadata")]
    AssetMismatch,
    #[msg("Market has not expired yet")]
    MarketNotExpired,
    #[msg("Market has not been settled yet")]
    MarketNotSettled,
    #[msg("Settlement price must be greater than zero")]
    InvalidSettlementPrice,

    // Collateral / vault validation
    #[msg("Collateral mint must be the protocol's USDC mint")]
    UnsupportedCollateral,

    // Position / contract errors (still used by v2 vault flow)
    #[msg("Insufficient collateral for this option")]
    InsufficientCollateral,
    #[msg("Contract size must be greater than zero")]
    InvalidContractSize,
    #[msg("Premium must be greater than zero")]
    InvalidPremium,

    // Authorization errors
    #[msg("Only the writer can perform this action")]
    NotWriter,
    #[msg("Cannot buy your own option")]
    CannotBuyOwnOption,

    // Token errors
    #[msg("Insufficient option tokens to exercise")]
    InsufficientOptionTokens,

    // Pricing / oracle errors (used by surviving solmath_bridge)
    #[msg("Option has already expired — cannot price")]
    OptionExpired,

    // Math errors
    #[msg("Arithmetic overflow")]
    MathOverflow,

    // =========================================================================
    // Shared Vault errors (v2 liquidity system)
    // =========================================================================
    #[msg("Custom vaults only allow the original creator to deposit")]
    CustomVaultSingleWriter,

    #[msg("Vault has been settled, no more deposits allowed")]
    VaultAlreadySettled,

    #[msg("Vault expiry has passed")]
    VaultExpired,

    #[msg("Invalid epoch expiry - must fall on configured day and hour")]
    InvalidEpochExpiry,

    #[msg("Insufficient free collateral in writer's vault position")]
    InsufficientVaultCollateral,

    #[msg("Collateral is committed to active options and cannot be withdrawn")]
    CollateralCommitted,

    #[msg("No unsold tokens to burn")]
    NoTokensToBurn,

    #[msg("Nothing to claim - all premium already withdrawn")]
    NothingToClaim,

    #[msg("Premium exceeds buyer's maximum (slippage protection)")]
    SlippageExceeded,

    #[msg("Vault not yet settled")]
    VaultNotSettled,

    #[msg("Option is not in the money - cannot exercise")]
    OptionNotInTheMoney,

    #[msg("Option mint does not belong to this vault")]
    InvalidVaultMint,

    #[msg("Claim all premium before withdrawing shares")]
    ClaimPremiumFirst,
}
