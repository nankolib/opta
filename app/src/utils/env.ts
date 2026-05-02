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

// ============================================================================
// Cluster inference & display helpers
// ============================================================================
//
// All three helpers derive the active Solana cluster from the connection
// RPC endpoint URL via substring match. This is robust against the two
// realistic deploy postures today:
//   - VITE_RPC_URL set to a private RPC (Helius URL contains "devnet" or
//     "mainnet" as part of the subdomain)
//   - VITE_RPC_URL unset → WalletContext falls back to clusterApiUrl(...)
//     which returns canonical https://api.<cluster>.solana.com URLs that
//     also contain the cluster name as a substring.
//
// Components that need cluster-aware UI should call:
//   const { connection } = useConnection();
//   const cluster = inferClusterFromUrl(connection.rpcEndpoint);
//   const label = getClusterDisplayLabel(cluster);
//   const url = getSolscanTxUrl(sig, cluster);
// ============================================================================

export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

/**
 * Infer the Solana cluster from an RPC endpoint URL via substring match.
 * Default fallback: "devnet" — matches the production posture today
 * (Vercel build env doesn't set VITE_RPC_URL, fallback resolves to
 * https://api.devnet.solana.com).
 */
export function inferClusterFromUrl(rpcUrl: string): Cluster {
  const lower = rpcUrl.toLowerCase();
  if (lower.includes("mainnet")) return "mainnet-beta";
  if (lower.includes("testnet")) return "testnet";
  if (lower.includes("localhost") || lower.includes("127.0.0.1")) return "localnet";
  return "devnet";
}

/**
 * Human-readable cluster label for the StatementHeader eyebrow line.
 * "Devnet · Solana" / "Mainnet · Solana" / "Testnet · Solana" / "Localnet · Solana"
 */
export function getClusterDisplayLabel(cluster: Cluster): string {
  const name =
    cluster === "mainnet-beta"
      ? "Mainnet"
      : cluster === "devnet"
        ? "Devnet"
        : cluster === "testnet"
          ? "Testnet"
          : "Localnet";
  return `${name} · Solana`;
}

/**
 * Build a Solscan tx URL for the given signature, with the right cluster
 * query param. Mainnet has no param (Solscan defaults to it); other
 * clusters get ?cluster=<name>. Localnet falls back to the standard
 * Solana Explorer with a customUrl param since Solscan can't index it.
 */
export function getSolscanTxUrl(signature: string, cluster: Cluster): string {
  if (cluster === "localnet") {
    return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=http://127.0.0.1:8899`;
  }
  if (cluster === "mainnet-beta") {
    return `https://solscan.io/tx/${signature}`;
  }
  return `https://solscan.io/tx/${signature}?cluster=${cluster}`;
}
