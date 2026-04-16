import "./polyfills";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletContextProvider } from "./contexts/WalletContext";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WalletContextProvider>
      <App />
    </WalletContextProvider>
  </StrictMode>,
);
