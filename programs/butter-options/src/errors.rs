// =============================================================================
// errors.rs — Custom error codes for the Butter Options protocol
// =============================================================================

use anchor_lang::prelude::*;

#[error_code]
pub enum ButterError {
    // Protocol errors
    #[msg("Protocol has already been initialized")]
    AlreadyInitialized,
    #[msg("Unauthorized: signer is not the protocol admin")]
    Unauthorized,

    // Market errors
    #[msg("Expiry timestamp must be in the future")]
    ExpiryInPast,
    #[msg("Strike price must be greater than zero")]
    InvalidStrikePrice,
    #[msg("Invalid Pyth price feed address")]
    InvalidPythFeed,
    #[msg("Asset name must be 1-16 characters")]
    InvalidAssetName,
    #[msg("Market has not expired yet")]
    MarketNotExpired,
    #[msg("Market has already been settled")]
    MarketAlreadySettled,
    #[msg("Market has not been settled yet")]
    MarketNotSettled,
    #[msg("Market has already expired")]
    MarketExpired,
    #[msg("Settlement price must be greater than zero")]
    InvalidSettlementPrice,

    // Position errors
    #[msg("Position is no longer active")]
    PositionNotActive,
    #[msg("Insufficient collateral for this option")]
    InsufficientCollateral,
    #[msg("Contract size must be greater than zero")]
    InvalidContractSize,
    #[msg("Premium must be greater than zero")]
    InvalidPremium,

    // Authorization errors
    #[msg("Only the writer can perform this action")]
    NotWriter,
    #[msg("Only the token holder can perform this action")]
    NotTokenHolder,
    #[msg("Cannot buy your own option")]
    CannotBuyOwnOption,

    // Token errors
    #[msg("Insufficient option tokens to exercise")]
    InsufficientOptionTokens,
    #[msg("Writer must hold all tokens to cancel (some were sold)")]
    TokensAlreadySold,

    // Resale errors
    #[msg("Option is not listed for resale")]
    NotListedForResale,
    #[msg("Option is already listed for resale")]
    AlreadyListedForResale,
    #[msg("Only the resale seller can cancel the listing")]
    NotResaleSeller,
    #[msg("Cannot buy your own resale listing")]
    CannotBuyOwnResale,

    // Validation errors
    #[msg("Asset class must be 0-4 (crypto, commodity, equity, forex, etf)")]
    InvalidAssetClass,

    // Math errors
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
