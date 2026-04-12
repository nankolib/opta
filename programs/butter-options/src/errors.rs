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

    // Expiry errors
    #[msg("Cannot expire an in-the-money option — holders must exercise first")]
    CannotExpireItmOption,

    // Premium errors
    #[msg("Purchase amount too small — premium rounds to zero")]
    PremiumTooLow,

    // Premium bounds errors (write_option)
    #[msg("Premium too low — must be at least 0.1% of collateral")]
    WritePremiumTooLow,
    #[msg("Premium too high — must be at most 50% of collateral")]
    WritePremiumTooHigh,

    // Pricing errors
    #[msg("Only the pricing update authority can update fair values")]
    UnauthorizedPricingUpdate,
    #[msg("Volatility too low — must be at least 500 bps (5%)")]
    VolTooLow,
    #[msg("Volatility too high — must be at most 50000 bps (500%)")]
    VolTooHigh,
    #[msg("Option has already expired — cannot price")]
    OptionExpired,
    #[msg("solmath pricing calculation failed")]
    PricingCalculationFailed,
    #[msg("Pyth oracle price is stale or invalid — must be less than 30 seconds old")]
    OracleStaleOrInvalid,

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

    // FIX H-02: vault-mint validation
    #[msg("Option mint does not belong to this vault")]
    InvalidVaultMint,

    // FIX M-01: vault-market parameter validation
    #[msg("Vault expiry must match market expiry")]
    ExpiryMismatch,

    // FIX M-01: option type mismatch
    #[msg("Vault option type must match market option type")]
    InvalidOptionType,
}
