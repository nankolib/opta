// =============================================================================
// state/mod.rs — Re-exports all account structures
// =============================================================================
//
// This module aggregates the three core account types so other parts of the
// program can import them with a single `use crate::state::*;`.
// =============================================================================

pub mod market;
pub mod position;
pub mod protocol;

pub use market::*;
pub use position::*;
pub use protocol::*;
