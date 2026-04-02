import { Buffer } from "buffer";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletContextProvider } from "./contexts/WalletContext";
import App from "./App";
import "./index.css";

// Polyfill Buffer for Solana libraries that expect Node.js globals
window.Buffer = Buffer;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletContextProvider>
      <App />
    </WalletContextProvider>
  </StrictMode>,
);
