import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { safeFetchAll } from "../../hooks/useFetchAccounts";
import { useVaults } from "../../hooks/useVaults";
import { usePythPrices } from "../../hooks/usePythPrices";
import { usePaperPalette } from "../../hooks";
import { TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import { usdcToNumber } from "../../utils/format";
import {
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { MoneyAmount } from "../../components/MoneyAmount";
import { StatementHeader, type Denomination } from "./StatementHeader";
import { SummaryBand, type SummaryCell } from "./SummaryBand";

interface PositionAccount {
  publicKey: PublicKey;
  account: any;
}
interface MarketAccount {
  publicKey: PublicKey;
  account: any;
}

/**
 * PortfolioPage — paper-surface page for the user's option positions.
 *
 * Stage 1 builds the shell: AppNav, StatementHeader, 4-cell SummaryBand,
 * and a placeholder for the Stage 2 positions table. Real on-chain
 * data drives the summary metrics; disconnected wallet renders all
 * four cells as "—".
 *
 * Summary derivations:
 *   - Open Positions: count of active held positions (v1 + v2),
 *     past-expiry excluded
 *   - Cost Basis: Σ premium × (heldBalance / totalSupply) — proportional
 *     because the on-chain protocol doesn't persist per-buyer purchase
 *     prices, only writer-side total premia per mint
 *   - Current Value: B-S fair value × balance for active pre-expiry;
 *     intrinsic × balance for settled-ITM still-held; $0 for
 *     settled-OTM still-held
 *   - Unrealised P&L: currentValue - costBasis, with percentage delta
 *
 * Stage 2 will replace the placeholder with the positions table and
 * row-level actions (exercise / list-for-resale / cancel / expire),
 * migrating logic from the legacy Portfolio.tsx that lived here
 * before this stage.
 */
export const PortfolioPage: FC = () => {
  usePaperPalette();
  const { publicKey, connected } = useWallet();
  const { program } = useProgram();
  const [positions, setPositions] = useState<PositionAccount[]>([]);
  const [markets, setMarkets] = useState<MarketAccount[]>([]);
  const [heldBalances, setHeldBalances] = useState<Map<string, number>>(new Map());
  const [denomination, setDenomination] = useState<Denomination>("USDC");

  const { vaults, vaultMints } = useVaults();
  const assetNames = useMemo(
    () => [...new Set(markets.map((m) => m.account.assetName as string))],
    [markets],
  );
  const { prices: spotPrices } = usePythPrices(assetNames);

  // Fetch positions and markets
  useEffect(() => {
    if (!program || !publicKey) return;
    Promise.all([
      safeFetchAll(program, "optionPosition"),
      safeFetchAll(program, "optionsMarket"),
    ])
      .then(([posns, mkts]) => {
        setPositions(posns as PositionAccount[]);
        setMarkets(mkts as MarketAccount[]);
      })
      .catch(console.error);
  }, [program, publicKey]);

  // Pull wallet's Token-2022 balances so we know which option mints
  // (v1 positions or v2 vault mints) the user actually holds.
  useEffect(() => {
    if (!publicKey || !program) {
      setHeldBalances(new Map());
      return;
    }
    (async () => {
      try {
        const accts = await program.provider.connection.getTokenAccountsByOwner(publicKey, {
          programId: TOKEN_2022_PROGRAM_ID,
        });
        const m = new Map<string, number>();
        for (const a of accts.value) {
          const mint = new PublicKey(a.account.data.slice(0, 32)).toBase58();
          const balance = Number(a.account.data.readBigUInt64LE(64));
          if (balance > 0) m.set(mint, balance);
        }
        setHeldBalances(m);
      } catch {
        setHeldBalances(new Map());
      }
    })();
  }, [publicKey, program]);

  const marketMap = useMemo(() => {
    const map = new Map<string, any>();
    markets.forEach((m) => map.set(m.publicKey.toBase58(), m.account));
    return map;
  }, [markets]);

  // Compute the four summary metrics. Returns nulls for the four
  // headline values when wallet is disconnected, so the SummaryBand
  // can render "—" placeholders cleanly.
  const summary = useMemo(() => {
    if (!connected || !publicKey) {
      return {
        openCount: null as number | null,
        callCount: 0,
        putCount: 0,
        costBasis: null as number | null,
        currentValue: null as number | null,
        pnl: null as number | null,
        pnlPercent: null as number | null,
      };
    }

    const now = Math.floor(Date.now() / 1000);

    // V1 held positions (any non-finalized position the wallet has tokens for)
    const v1Held = positions.filter((p) => {
      if (p.account.isExercised || p.account.isExpired || p.account.isCancelled) return false;
      const bal = heldBalances.get(p.account.optionMint.toBase58());
      return !!bal && bal > 0;
    });

    // V2 held vault tokens (paired with the parent vault + market)
    const v2Held: { vaultMint: any; vault: any; balance: number; market: any | null }[] = [];
    for (const vm of vaultMints) {
      const mintKey = (vm.account.optionMint as PublicKey).toBase58();
      const balance = heldBalances.get(mintKey);
      if (!balance) continue;
      const vault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
      if (!vault) continue;
      const market = marketMap.get((vault.account.market as PublicKey).toBase58()) ?? null;
      v2Held.push({ vaultMint: vm, vault, balance, market });
    }

    // Active filter (pre-expiry) for the headline open-count + calls/puts split
    const v1Active = v1Held.filter((p) => {
      const mkt = marketMap.get(p.account.market.toBase58());
      if (!mkt) return false;
      const exp =
        typeof mkt.expiryTimestamp === "number"
          ? mkt.expiryTimestamp
          : mkt.expiryTimestamp.toNumber();
      return exp > now;
    });
    const v2Active = v2Held.filter(({ vault }) => {
      const v = vault.account;
      const exp = typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
      return exp > now;
    });

    let callCount = 0;
    let putCount = 0;
    for (const p of v1Active) {
      const mkt = marketMap.get(p.account.market.toBase58())!;
      if ("call" in mkt.optionType) callCount++;
      else putCount++;
    }
    for (const { vault } of v2Active) {
      if ("call" in vault.account.optionType) callCount++;
      else putCount++;
    }
    const openCount = v1Active.length + v2Active.length;

    // Cost basis: Σ premium × (heldBalance / totalSupply). Uses ALL held
    // (active + post-expiry-still-held) so settled-ITM positions still
    // count toward "what I paid" until the user exercises and burns.
    let costBasis = 0;
    for (const p of v1Held) {
      const balance = heldBalances.get(p.account.optionMint.toBase58()) ?? 0;
      const totalSupply = p.account.totalSupply?.toNumber?.() || 1;
      const premium = usdcToNumber(p.account.premium);
      costBasis += premium * (balance / totalSupply);
    }
    for (const { vaultMint, balance } of v2Held) {
      const totalSupply = vaultMint.account.totalSupply?.toNumber?.() || 1;
      const premium = usdcToNumber(vaultMint.account.premium ?? 0);
      costBasis += premium * (balance / totalSupply);
    }

    // Current value: B-S for active, intrinsic for settled-ITM, 0 for settled-OTM.
    // Skips positions whose Pyth feed hasn't returned (better to undercount
    // than mislead — same posture the legacy summary used).
    let currentValue = 0;
    for (const p of v1Held) {
      const mkt = marketMap.get(p.account.market.toBase58());
      if (!mkt) continue;
      const balance = heldBalances.get(p.account.optionMint.toBase58()) ?? 0;
      const isCall = "call" in mkt.optionType;
      const strike = usdcToNumber(mkt.strikePrice);
      if (mkt.isSettled) {
        const settle = usdcToNumber(mkt.settlementPrice);
        const intrinsic = isCall ? Math.max(0, settle - strike) : Math.max(0, strike - settle);
        currentValue += intrinsic * balance;
      } else {
        const spot = spotPrices[mkt.assetName];
        if (!spot || spot <= 0) continue;
        const exp =
          typeof mkt.expiryTimestamp === "number"
            ? mkt.expiryTimestamp
            : mkt.expiryTimestamp.toNumber();
        const days = Math.max(0, (exp - now) / 86400);
        const vol = getDefaultVolatility(mkt.assetName);
        const fair = isCall
          ? calculateCallPremium(spot, strike, days, vol)
          : calculatePutPremium(spot, strike, days, vol);
        currentValue += fair * balance;
      }
    }
    for (const { vault, balance, market } of v2Held) {
      const v = vault.account;
      const isCall = "call" in v.optionType;
      const strike = usdcToNumber(v.strikePrice);
      if (v.isSettled) {
        const settle = usdcToNumber(v.settlementPrice);
        const intrinsic = isCall ? Math.max(0, settle - strike) : Math.max(0, strike - settle);
        currentValue += intrinsic * balance;
      } else {
        const spot = market ? spotPrices[market.assetName] : 0;
        if (!spot || spot <= 0) continue;
        const exp = typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
        const days = Math.max(0, (exp - now) / 86400);
        const assetName = market?.assetName ?? "SOL";
        const vol = getDefaultVolatility(assetName);
        const fair = isCall
          ? calculateCallPremium(spot, strike, days, vol)
          : calculatePutPremium(spot, strike, days, vol);
        currentValue += fair * balance;
      }
    }

    const pnl = currentValue - costBasis;
    const pnlPercent = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

    return { openCount, callCount, putCount, costBasis, currentValue, pnl, pnlPercent };
  }, [connected, publicKey, positions, vaultMints, vaults, marketMap, heldBalances, spotPrices]);

  const monthLabel = useMemo(() => {
    return new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }, []);

  const timestampLabel = useMemo(() => {
    const now = new Date();
    const datePart = now.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    const timePart = now.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    return `${datePart} · ${timePart} UTC`;
  }, []);

  // P&L color logic: positive = muted green, negative = crimson, zero = ink.
  const pnlColorClass =
    summary.pnl === null || summary.pnl === 0
      ? ""
      : summary.pnl > 0
        ? "text-emerald-700"
        : "text-crimson";

  const cells: [SummaryCell, SummaryCell, SummaryCell, SummaryCell] = [
    {
      label: "Open Positions",
      value: summary.openCount === null ? "—" : summary.openCount.toString(),
      sub:
        summary.openCount === null
          ? "Connect wallet"
          : `${summary.callCount} calls · ${summary.putCount} puts`,
    },
    {
      label: "Cost Basis",
      value: summary.costBasis === null ? "—" : <MoneyAmount value={summary.costBasis} />,
      sub: "USDC · Paid premia",
    },
    {
      label: "Current Value",
      value:
        summary.currentValue === null ? "—" : <MoneyAmount value={summary.currentValue} />,
      sub: "Mark · Black–Scholes",
    },
    {
      label: "Unrealised P&L",
      value:
        summary.pnl === null ? (
          "—"
        ) : (
          <span className={pnlColorClass}>
            <MoneyAmount value={summary.pnl} showSign />
          </span>
        ),
      sub:
        summary.pnl === null || summary.pnlPercent === null
          ? "Connect wallet"
          : `${summary.pnl >= 0 ? "▲" : "▼"} ${Math.abs(summary.pnlPercent).toFixed(2)}% vs cost`,
    },
  ];

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(80px,14vh,160px)]">
        <StatementHeader
          monthLabel={monthLabel}
          timestampLabel={timestampLabel}
          denomination={denomination}
          onDenominationChange={setDenomination}
        />
        <SummaryBand cells={cells} />

        {/* Stage 2 placeholder for the positions table */}
        <div className="mt-16 border border-rule rounded-md p-12 text-center">
          <p className="font-fraunces-text italic font-light leading-[1.55] opacity-60 text-[clamp(16px,1.3vw,18px)] m-0">
            Positions table coming in Stage 2.
          </p>
        </div>
      </main>
    </div>
  );
};

export default PortfolioPage;
