import { FC, ReactNode, useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";

// Import wallet adapter CSS
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * WalletContextProvider wraps the entire app with Solana wallet connectivity.
 *
 * - Connects to devnet RPC
 * - Supports Phantom wallet (primary for hackathon demo)
 * - Provides the wallet modal UI for connecting/disconnecting
 */
export const WalletContextProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  // Devnet endpoint — switch to mainnet-beta for production
  const endpoint = useMemo(() => clusterApiUrl("devnet"), []);

  // Wallets to support. Phantom is the primary wallet for Solana.
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
};
