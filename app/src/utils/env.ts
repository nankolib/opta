import { DEFAULT_HERMES_BASE } from "./pythPullPost";

/**
 * Resolve the Hermes endpoint URL for runtime calls. Reads
 * `VITE_HERMES_BASE` from Vite's env (set in `app/.env.local`); falls
 * back to the mainnet default exported from `pythPullPost.ts`.
 *
 * Centralised so all call sites (NewMarketModal, AdminTools, future)
 * resolve the same way and a single override flips the whole frontend.
 *
 * The empty-string guard handles the case where `.env.local` defines
 * `VITE_HERMES_BASE=` with no value — Vite emits an empty string for
 * that, which we treat as unset.
 */
export function getHermesBase(): string {
  const v = import.meta.env.VITE_HERMES_BASE;
  return typeof v === "string" && v.length > 0 ? v : DEFAULT_HERMES_BASE;
}
