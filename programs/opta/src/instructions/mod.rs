// =============================================================================
// instructions/mod.rs — Re-exports all instruction modules
// =============================================================================

pub mod create_market;
pub mod initialize_protocol;
pub mod migrate_pyth_feed;
pub mod settle_expiry;

// v2 shared vault instructions
pub mod initialize_epoch_config;
pub mod create_shared_vault;
pub mod deposit_to_vault;
pub mod mint_from_vault;
pub mod purchase_from_vault;
pub mod burn_unsold_from_vault;
pub mod withdraw_from_vault;
pub mod claim_premium;
pub mod settle_vault;
pub mod exercise_from_vault;
pub mod withdraw_post_settlement;
pub mod auto_finalize_holders;

pub use create_market::*;
pub use initialize_protocol::*;
pub use migrate_pyth_feed::*;
pub use settle_expiry::*;

// v2 shared vault instructions
pub use initialize_epoch_config::*;
pub use create_shared_vault::*;
pub use deposit_to_vault::*;
pub use mint_from_vault::*;
pub use purchase_from_vault::*;
pub use burn_unsold_from_vault::*;
pub use withdraw_from_vault::*;
pub use claim_premium::*;
pub use settle_vault::*;
pub use exercise_from_vault::*;
pub use withdraw_post_settlement::*;
pub use auto_finalize_holders::*;
