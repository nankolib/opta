import type { FC } from "react";
import { useMemo } from "react";
import { PublicKey } from "@solana/web3.js";
import { MoneyAmount } from "../../components/MoneyAmount";
import { HairlineRule } from "../../components/layout";
import { truncateAddress } from "../../utils/format";
import type { Offering } from "./useTradeData";

type OfferingsPanelProps = {
  asset: string;
  side: "call" | "put";
  strike: number;
  expiry: number;
  spot: number | null;
  /** B-S fair premium for this (strike, side) — `row.callPremium` or `row.putPremium`. */
  fairPremium: number;
  /** Smile-adjusted IV (decimal, e.g. 0.78 = 78%). Used for the header strip only. */
  ivSmiled: number;
  /** Pre-sorted ascending by premium per Slice 1. Self-listings are tagged via offering.isSelfListing. */
  offerings: Offering[];
  /** Currently selected offering for highlight. Compared by stable key, not identity. */
  selected: Offering | null;
  /** Selection callback. Self-listings invoke a no-op — the panel guards. */
  onSelect: (o: Offering) => void;
};

/**
 * Display-only panel rendering every buyable offering at a (strike, side, expiry) cell.
 *
 * Layout:
 *   - Header strip: asset · side · strike · expiry · spot · fair · IV · DTE
 *   - Vault card (full ink, bordered, top of panel) OR muted "fully written" placeholder
 *   - Resale rows (hairline-divided, sorted ascending by premium per the Slice 1 invariant)
 *   - Footer: best-ask + qty-at-best summary, excluding self-listings
 *
 * Self-listings (`offering.isSelfListing === true`) render at opacity 0.4 with a
 * `·your listing` tag instead of the action arrow. `onSelect` is a no-op for
 * self-listings — the panel doesn't dispatch on them.
 *
 * Slice 3 builds and exports this component. Slice 4 mounts it inside the unified
 * BuyModal. The `?devPanel=1` mount in TradePage is for the Slice 3 visual smoke
 * only and is removed before commit.
 */
export const OfferingsPanel: FC<OfferingsPanelProps> = ({
  asset,
  side,
  strike,
  expiry,
  spot,
  fairPremium,
  ivSmiled,
  offerings,
  selected,
  onSelect,
}) => {
  const expiryLabel = useMemo(() => formatTableDate(expiry), [expiry]);
  const dteLabel = useMemo(() => {
    const days = Math.max(0, Math.floor((expiry - Date.now() / 1000) / 86400));
    return `${days}D`;
  }, [expiry]);

  const vaultOffering = useMemo(
    () =>
      offerings.find(
        (o): o is Extract<Offering, { kind: "vault" }> => o.kind === "vault",
      ) ?? null,
    [offerings],
  );
  const resaleOfferings = useMemo(
    () =>
      offerings.filter(
        (o): o is Extract<Offering, { kind: "resale" }> => o.kind === "resale",
      ),
    [offerings],
  );

  // Best-ask excludes self-listings — your own ask isn't a third-party offer.
  const bestThirdParty = useMemo(
    () =>
      offerings.find((o) => !(o.kind === "resale" && o.isSelfListing)) ?? null,
    [offerings],
  );

  const selectedKey = selected ? offeringKey(selected) : null;

  return (
    <div className="bg-paper border border-rule rounded-md p-6 w-full">
      {/* ── Header strip ───────────────────────────────────────── */}
      <div className="mb-5">
        <div className="flex items-baseline gap-3 mb-1.5 flex-wrap">
          <span className="font-fraunces-text italic text-ink text-[20px] leading-tight">
            {asset}
          </span>
          <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em]">
            <span
              aria-hidden="true"
              className="inline-block w-[6px] h-[6px] rounded-full bg-crimson"
            />
            {side}
          </span>
          <span className="font-mono text-[13px] text-ink">
            ${strike.toFixed(2)}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] opacity-55">
            {expiryLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-65">
          <span>
            Spot {spot != null ? <MoneyAmount value={spot} /> : "—"}
          </span>
          <span>
            Fair <MoneyAmount value={fairPremium} />
          </span>
          <span>IV {(ivSmiled * 100).toFixed(1)}%</span>
          <span>{dteLabel}</span>
        </div>
      </div>

      <HairlineRule className="mb-5" />

      {/* ── Vault card ─────────────────────────────────────────── */}
      {vaultOffering ? (
        <VaultCard
          offering={vaultOffering}
          fairPremium={fairPremium}
          isSelected={selectedKey === offeringKey(vaultOffering)}
          onSelect={() => onSelect(vaultOffering)}
        />
      ) : (
        <VaultMutedCard />
      )}

      {/* ── Resale rows ────────────────────────────────────────── */}
      {resaleOfferings.length > 0 ? (
        <>
          <div className="flex items-baseline justify-between mt-6 mb-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
              Resale listings
            </span>
            <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-45">
              sorted ↑
            </span>
          </div>
          <div className="border-t border-rule-soft">
            {resaleOfferings.map((o) => (
              <ResaleRow
                key={o.listing.publicKey.toBase58()}
                offering={o}
                fairPremium={fairPremium}
                isSelected={selectedKey === offeringKey(o)}
                onSelect={() => {
                  if (o.isSelfListing) return;
                  onSelect(o);
                }}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-45 mt-6">
          No resale listings at this strike
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────────── */}
      <HairlineRule className="my-5" weight="soft" />
      <Footer bestThirdParty={bestThirdParty} />
    </div>
  );
};

const VaultCard: FC<{
  offering: Extract<Offering, { kind: "vault" }>;
  fairPremium: number;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ offering, fairPremium, isSelected, onSelect }) => {
  const premiumPct = computePremiumPct(offering.premium, fairPremium);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className={`block w-full text-left rounded-sm p-4 transition-colors duration-200 ease-opta ${
        isSelected
          ? "border-2 border-ink bg-paper-2"
          : "border border-rule hover:border-ink"
      }`}
    >
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
          Vault
        </span>
        {isSelected && (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-crimson">
            selected
          </span>
        )}
      </div>
      <div className="flex items-baseline gap-4 mb-1.5 flex-wrap">
        <span className="font-mono text-[18px] text-ink">
          <MoneyAmount value={offering.premium} />
        </span>
        <span className="font-mono text-[12px] opacity-70">
          {offering.inventory.toLocaleString()} available
        </span>
        <PremiumPill premiumPct={premiumPct} />
      </div>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-50">
        Live premium · Black-Scholes derived
      </div>
    </button>
  );
};

const VaultMutedCard: FC = () => (
  <div className="rounded-sm border border-rule-soft p-4 opacity-60">
    <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-1.5">
      Vault
    </div>
    <div className="font-mono text-[14px] text-ink">Fully written</div>
    <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-50 mt-1">
      No vault inventory at this strike — secondary listings only
    </div>
  </div>
);

const ResaleRow: FC<{
  offering: Extract<Offering, { kind: "resale" }>;
  fairPremium: number;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ offering, fairPremium, isSelected, onSelect }) => {
  const premiumPct = computePremiumPct(offering.premium, fairPremium);

  if (offering.isSelfListing) {
    return (
      <div className="flex items-baseline gap-4 py-3 px-1 border-b border-rule-soft opacity-40 flex-wrap">
        <span className="font-mono text-[14px] text-ink min-w-[80px]">
          <MoneyAmount value={offering.premium} />
        </span>
        <span className="font-mono text-[11px] opacity-70 min-w-[88px]">
          {offering.qty.toLocaleString()}{" "}
          {offering.qty === 1 ? "contract" : "contracts"}
        </span>
        <PremiumPill premiumPct={premiumPct} />
        <span className="font-mono text-[11px] opacity-65">
          {truncateAddress(offering.seller.toBase58())}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-50">
          {formatRelative(offering.createdAt)}
        </span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] opacity-55 italic">
          ·your listing
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={isSelected}
      className={`flex w-full text-left items-baseline gap-4 py-3 px-1 border-b border-rule-soft transition-colors duration-200 ease-opta flex-wrap ${
        isSelected ? "bg-paper-2" : "hover:bg-paper-2"
      }`}
    >
      <span className="font-mono text-[14px] text-ink min-w-[80px]">
        <MoneyAmount value={offering.premium} />
      </span>
      <span className="font-mono text-[11px] opacity-70 min-w-[88px]">
        {offering.qty.toLocaleString()}{" "}
        {offering.qty === 1 ? "contract" : "contracts"}
      </span>
      <PremiumPill premiumPct={premiumPct} />
      <span className="font-mono text-[11px] opacity-65">
        {truncateAddress(offering.seller.toBase58())}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-50">
        {formatRelative(offering.createdAt)}
      </span>
      <span
        className="ml-auto font-mono text-[12px] opacity-65"
        aria-hidden="true"
      >
        →
      </span>
    </button>
  );
};

const Footer: FC<{ bestThirdParty: Offering | null }> = ({ bestThirdParty }) => {
  if (!bestThirdParty) {
    return (
      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-55">
        No third-party offerings — your own listings shown above
      </div>
    );
  }
  const inv =
    bestThirdParty.kind === "vault"
      ? bestThirdParty.inventory
      : bestThirdParty.qty;
  return (
    <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-65">
      Best ask <MoneyAmount value={bestThirdParty.premium} /> · Up to{" "}
      {inv.toLocaleString()} contracts at this price
    </div>
  );
};

const PremiumPill: FC<{ premiumPct: number | null }> = ({ premiumPct }) => {
  if (premiumPct == null) return null;
  const absPct = Math.abs(premiumPct);
  if (absPct < 0.5) {
    return <span className="font-mono text-[11px] text-ink/70">at fair</span>;
  }
  if (premiumPct < 0) {
    return (
      <span className="font-mono text-[11px] text-emerald-700">
        {absPct.toFixed(1)}% below fair
      </span>
    );
  }
  return (
    <span className="font-mono text-[11px] text-crimson">
      {absPct.toFixed(1)}% above fair
    </span>
  );
};

function offeringKey(o: Offering): string {
  if (o.kind === "vault") {
    return `vault:${(o.vaultMint.publicKey as PublicKey).toBase58()}`;
  }
  return `resale:${(o.listing.publicKey as PublicKey).toBase58()}`;
}

function computePremiumPct(price: number, fair: number): number | null {
  if (fair <= 0) return null;
  return (price / fair - 1) * 100;
}

function formatTableDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatRelative(unix: number): string {
  const now = Date.now() / 1000;
  const diff = now - unix;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}M ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}H ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}D ago`;
  return `${Math.floor(diff / (86400 * 30))}MO ago`;
}

export default OfferingsPanel;
