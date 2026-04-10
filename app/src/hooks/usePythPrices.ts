import { useState, useEffect } from "react";

const PYTH_HERMES_FEED_IDS: Record<string, string> = {
  "SOL": "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BTC": "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH": "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "XAU": "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
  "WTI": "0xc7c60099fea781c08eb7d3e3d23b58c304e4da6cb8ad9dd0ad80fa3d204bc424",
  "AAPL": "0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  "TSLA": "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
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

    const feedEntries = assetNames
      .filter((name) => PYTH_HERMES_FEED_IDS[name])
      .map((name) => ({ name, id: PYTH_HERMES_FEED_IDS[name] }));

    if (feedEntries.length === 0) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const fetchPrices = async () => {
      try {
        const params = feedEntries.map((e) => `ids[]=${e.id}`).join("&");
        const resp = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?${params}`);
        if (!resp.ok) throw new Error(`Hermes API ${resp.status}`);
        const data = await resp.json();

        if (cancelled) return;

        const newPrices: Record<string, number> = {};
        for (const entry of feedEntries) {
          const parsed = data.parsed?.find((p: any) => `0x${p.id}` === entry.id);
          if (parsed?.price) {
            const price = parseInt(parsed.price.price) * Math.pow(10, parsed.price.expo);
            newPrices[entry.name] = price;
          }
        }
        setPrices(newPrices);
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to fetch prices");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, 10_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [assetKey]);

  return { prices, loading, error };
}
