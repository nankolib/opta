import { useState, useEffect } from "react";

// Map asset names to CoinGecko IDs (crypto only — CoinGecko doesn't have commodities/equities)
const COINGECKO_IDS: Record<string, string> = {
  "SOL": "solana",
  "BTC": "bitcoin",
  "ETH": "ethereum",
};

// Fallback prices for non-crypto assets. Updated 2026-04-16.
// These are used when no live API returns a price. Update before demos.
const STATIC_FALLBACKS: Record<string, number> = {
  "SOL": 86,
  "BTC": 74000,
  "ETH": 2300,
  "XAU": 3230,    // Gold per troy oz
  "XAG": 32.50,   // Silver per troy oz
  "WTI": 61,      // Crude oil per barrel
  "AAPL": 198,    // Apple Inc.
  "TSLA": 252,    // Tesla Inc.
  "NVDA": 135,    // NVIDIA Corp.
};

export function usePythPrices(assetNames: string[]): {
  prices: Record<string, number>;
  loading: boolean;
  error: string | null;
} {
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const assetKey = assetNames.sort().join(",");

  useEffect(() => {
    if (assetNames.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const fetchPrices = async () => {
      const newPrices: Record<string, number> = {};

      // 1. Try CoinGecko for crypto assets (SOL, BTC, ETH)
      const cryptoAssets = assetNames.filter((name) => COINGECKO_IDS[name]);
      if (cryptoAssets.length > 0) {
        try {
          const ids = cryptoAssets.map((name) => COINGECKO_IDS[name]).join(",");
          const resp = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
          );
          if (resp.ok) {
            const data = await resp.json();
            for (const name of cryptoAssets) {
              const cgId = COINGECKO_IDS[name];
              if (data[cgId]?.usd) {
                newPrices[name] = data[cgId].usd;
              }
            }
          } else {
            console.warn("[Prices] CoinGecko failed:", resp.status);
          }
        } catch (err) {
          console.warn("[Prices] CoinGecko error:", err);
        }
      }

      // 2. Fallback: Try Jupiter for SOL if CoinGecko missed it
      if (!newPrices["SOL"] && assetNames.includes("SOL")) {
        try {
          const resp = await fetch(
            "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112",
          );
          if (resp.ok) {
            const data = await resp.json();
            const solPrice = data?.data?.["So11111111111111111111111111111111111111112"]?.price;
            if (solPrice) {
              newPrices["SOL"] = parseFloat(solPrice);
            }
          }
        } catch (err) {
          console.warn("[Prices] Jupiter error:", err);
        }
      }

      // 3. Static fallbacks for any asset still missing a price
      for (const name of assetNames) {
        if (!newPrices[name] && STATIC_FALLBACKS[name]) {
          newPrices[name] = STATIC_FALLBACKS[name];
          console.warn(`[Prices] Using static fallback for ${name}: $${STATIC_FALLBACKS[name]}`);
        }
      }

      if (!cancelled) {
        setPrices(newPrices);
        setError(null);
        setLoading(false);
      }
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, 30_000); // 30s to respect rate limits

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [assetKey]);

  return { prices, loading, error };
}
