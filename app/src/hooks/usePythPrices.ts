import { useState, useEffect } from "react";

// Map asset names to CoinGecko IDs
const COINGECKO_IDS: Record<string, string> = {
  "SOL": "solana",
  "BTC": "bitcoin",
  "ETH": "ethereum",
  "XAU": "gold",         // not on CoinGecko — will use hardcoded fallback
  "WTI": "crude-oil",    // not on CoinGecko — will use hardcoded fallback
  "AAPL": "apple",       // not on CoinGecko — will use hardcoded fallback
  "TSLA": "tesla",       // not on CoinGecko — will use hardcoded fallback
};

// Approximate fallback prices for non-crypto assets (hackathon only)
const STATIC_FALLBACKS: Record<string, number> = {
  "XAU": 3200,
  "WTI": 62,
  "AAPL": 198,
  "TSLA": 252,
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
      const cryptoAssets = assetNames.filter(
        (name) => ["SOL", "BTC", "ETH"].includes(name)
      );
      if (cryptoAssets.length > 0) {
        try {
          const ids = cryptoAssets
            .map((name) => COINGECKO_IDS[name])
            .filter(Boolean)
            .join(",");
          const resp = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
          );
          if (resp.ok) {
            const data = await resp.json();
            for (const name of cryptoAssets) {
              const cgId = COINGECKO_IDS[name];
              if (cgId && data[cgId]?.usd) {
                newPrices[name] = data[cgId].usd;
              }
            }
            console.log("[Prices] CoinGecko:", newPrices);
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
            "https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112"
          );
          if (resp.ok) {
            const data = await resp.json();
            const solPrice = data?.data?.["So11111111111111111111111111111111111111112"]?.price;
            if (solPrice) {
              newPrices["SOL"] = parseFloat(solPrice);
              console.log("[Prices] Jupiter SOL:", newPrices["SOL"]);
            }
          }
        } catch (err) {
          console.warn("[Prices] Jupiter error:", err);
        }
      }

      // 3. Static fallbacks for non-crypto assets (hackathon demo)
      for (const name of assetNames) {
        if (!newPrices[name] && STATIC_FALLBACKS[name]) {
          newPrices[name] = STATIC_FALLBACKS[name];
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
