import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { NumericField } from "../../components/NumericField";
import posthog from "posthog-js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useProgram } from "../../hooks/useProgram";
import { useBook, type BookOrder } from "../../hooks/useBook";
import { usePegFill, usePostOrder, useFillOrder, useFillWriterAsk } from "../../hooks/useOrderFlows";
import { deriveOrderPubkey } from "./orderFlows";
import { refreshAfterMutation } from "./orderRefresh";
import { TxOutcomeError } from "../../utils/txOutcome";
import { planSweep, executeSweep, buildAskLevels, buildBidLevels, crossLimit, buyRoutesToPeg } from "./marketSweep";
import type { SendPhase } from "../../utils/sendWithFreshBlockhash";
import { sendWithFreshBlockhash, type SendableProvider } from "../../utils/sendWithFreshBlockhash";
import { calculateCallPremium, calculatePutPremium } from "../../utils/blackScholes";
import { buildTriggerPlacement, type TriggerLeg } from "../../utils/triggerBundle";
import { calculateCallGreeks, calculatePutGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { TOKEN_2022_PROGRAM_ID, MARKET_SEED, PROGRAM_ID, DEVNET_USDC_MINT } from "../../utils/constants";
import {
  fetchOptionPriceQuote, describeOptionPriceQuoteStatus, quoteFreshness,
  OptionPriceQuoteFailure, type OptionPriceQuote,
} from "../../utils/optionPriceQuote";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";
import { useVolOracleStatus } from "../../hooks/useVolOracleStatus";
import { writeWarmupGate } from "../../utils/oracleArm";
import {
  alreadyMetLegs, alreadyMetMessage, formatSpotForLabel, isEffectivelyWorthless,
  spotAnchoredPlaceholder,
} from "../../utils/triggerGuards";
import { emitMutation } from "../../utils/mutationBus";
import { resolveAuthoritativeSeries } from "../../utils/authoritativeSeries";

// Quote-on-demand short-TTL cache, keyed by series mint (premium is per-contract,
// size-independent). Browsing the chain never touches this — only the RFQ button.
const RFQ_TTL_MS = 15_000;
const rfqCache = new Map<string, { q: OptionPriceQuote; at: number }>();

/**
 * OrderTicket — the write path for the v2 Trade page. Terminal design language
 * (design lock 2026-07-09): mono-plex numerals, hairline panels, side-colored
 * segments, one teal-fill primary submit.
 *
 * `variant`:
 *   "standalone" — full self-contained ticket (own header + RFQ request block).
 *   "docked"     — lives inside the docked ContractInspector, which owns the
 *                  header/badges + protocol-quote centerpiece + RFQ request, and
 *                  seeds this ticket's quote via `seedQuote`. Header + the RFQ
 *                  request block are suppressed to avoid duplication; every gate
 *                  (incl. H-05 American freshness) still runs off the seed quote.
 *
 * Routing (provenance × type × side):
 *   SERIES Buy·Market  → best ask: resting ask ≤ peg → fill_order; else fill_vault_peg
 *   SERIES Buy·Limit   → post_order BID (escrow USDC)
 *   SERIES Sell·Market → fill_order vs best resting BID
 *   SERIES Sell·Limit  → post_order ResaleAsk on HELD tokens (gated on balance)
 *   LEGACY Buy         → classic flow (existing BuyModal) via onLegacyBuy
 *   LEGACY Sell·Limit  → list via Portfolio (position-bound) — pointer only
 */
type Side = "buy" | "sell" | "write";
type OrderType = "market" | "limit" | "stop" | "tpsl";
const LIVE_TYPES: OrderType[] = ["market", "limit"];

const SIDE_VAR: Record<Side, string> = { buy: "--color-l-up", sell: "--color-l-down", write: "--color-l-text" };

export const OrderTicket: FC<{
  row: UnifiedChainRow;
  spot: number | null;
  onDone: () => void;
  onLegacyBuy: (row: UnifiedChainRow) => void;
  /** Pre-seed the RFQ (e.g. the inspector's on-open quote) so the ticket shows
   *  the protocol price immediately without a second click. */
  seedQuote?: OptionPriceQuote | null;
  variant?: "standalone" | "docked";
  /** Deep-link / caller-preselected side (loads the ticket ready to act). */
  initialSide?: Side;
}> = ({ row, spot, onDone, onLegacyBuy, seedQuote = null, variant = "standalone", initialSide }) => {
  const docked = variant === "docked";
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const { orders } = useBook();
  const peg = usePegFill();
  const post = usePostOrder();
  const fill = useFillOrder();
  const fillWA = useFillWriterAsk();

  const [side, setSide] = useState<Side>(initialSide ?? "buy");
  const [type, setType] = useState<OrderType>("market");
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState<number>(0);
  const [slippagePct, setSlippagePct] = useState(5);
  const [held, setHeld] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null); // dollars; for the Write collateral gate
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // What the in-flight order is ACTUALLY waiting on. The button used to read
  // "confirming on chain" from the instant of the click — through the ~1 s of
  // account reads, through however long the wallet sits on the prompt, and
  // before any signature existed. On a 30–50 s Phantom stall that is not a
  // cosmetic inaccuracy: it tells the user the chain is busy when the truth is
  // that their wallet is waiting for them. Null on the paths that do not report
  // phases yet (post/fill/cancel via the .rpc() hooks) — those keep "Submitting…".
  const [phase, setPhase] = useState<SendPhase | null>(null);

  // RFQ (quote-on-demand) state.
  const [rfq, setRfq] = useState<OptionPriceQuote | null>(null);
  // TP/SL (Phase 4). Either field may be left empty — a single leg is
  // first-class, and nothing forces a take-profit to get a stop.
  const [tpPrice, setTpPrice] = useState<number>(0);
  const [slPrice, setSlPrice] = useState<number>(0);
  // Explicit acknowledgement that a leg would fire on the keeper's next tick.
  // Reset whenever a price changes, so a confirmation can never carry over to a
  // different number than the one it was given for.
  const [confirmImmediate, setConfirmImmediate] = useState(false);
  useEffect(() => { setConfirmImmediate(false); }, [tpPrice, slPrice]);
  /** Per-contract MINIMUM PROCEEDS the book must beat. 0 is legal on chain and
   *  means BOOK INELIGIBLE (6082), so it is surfaced rather than defaulted. */
  const [sellFloor, setSellFloor] = useState<number>(0);
  const [vaultMarket, setVaultMarket] = useState<string | null>(null);
  const [rfqLoading, setRfqLoading] = useState(false);
  const [rfqError, setRfqError] = useState<OptionPriceQuoteFailure | null>(null);
  // BUG-1: contracts the vault can still mint-on-fill. Null until the focused
  // vault is read; suppresses a Buy·Market that would route to an exhausted peg
  // and revert InsufficientVaultCollateral on-chain.
  const [pegRemaining, setPegRemaining] = useState<number | null>(null);

  const isSeries = row.provenance === "series";
  const isWrite = side === "write";
  // Pricing axis — American contracts (legacy OR series) price via the on-chain
  // get_option_price view. Routing (below) stays on `isSeries` (provenance).
  const useOnChainQuote = row.exerciseStyle === "american";

  // Follow a caller-driven side change (deep-link / row reselect).
  useEffect(() => { if (initialSide) setSide(initialSide); }, [initialSide]);

  // Keep the latest inspector seed WITHOUT making it a dep of the reset effect —
  // a churning seedQuote must not re-fire the reset and CLOBBER a user-requested
  // rfq. (Ref writes during render are safe; a ref is not state.)
  const seedRef = useRef(seedQuote);
  seedRef.current = seedQuote;
  // Reset the RFQ only when the focused CONTRACT changes, seeding from the
  // caller's one-shot quote as it stands at that moment.
  useEffect(() => {
    setRfq(seedRef.current ?? null);
    setRfqError(null);
  }, [row.vault, row.optionType, row.strike]);
  // Adopt a late-arriving seed for the SAME contract only while we have no quote
  // yet — never overwrite a user-obtained rfq.
  useEffect(() => {
    if (seedQuote) setRfq((cur) => cur ?? seedQuote);
  }, [seedQuote]);

  // On-chain quote-on-demand: fire get_option_price for this series (American
  // only). Short-TTL cached by mint; never auto-fires — button-triggered.
  async function requestQuote() {
    if (!program || !useOnChainQuote) return;
    const key = row.optionMint ?? `${row.vault}:${row.optionType}`;
    const hit = rfqCache.get(key);
    if (hit && Date.now() - hit.at < RFQ_TTL_MS) { setRfq(hit.q); setRfqError(null); return; }
    setRfqLoading(true); setRfqError(null);
    try {
      const marketPda = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(row.asset)], PROGRAM_ID)[0];
      const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
      const q = await fetchOptionPriceQuote(program as any, { publicKey: marketPda, account: { pythFeedId: mkt.pythFeedId } }, {
        strike: row.strike, expiryTs: row.expiry, side: row.optionType, exerciseStyle: "american", carryRateBps: 0,
      });
      rfqCache.set(key, { q, at: Date.now() });
      setRfq(q);
    } catch (e: any) {
      setRfqError(e instanceof OptionPriceQuoteFailure ? e : new OptionPriceQuoteFailure("unknown", null));
      setRfq(null);
    } finally {
      setRfqLoading(false);
    }
  }

  // Held balance of the focused series mint (for Sell·Limit gate + Sell·Market).
  useEffect(() => {
    let live = true;
    setHeld(null);
    if (!isSeries || !row.optionMint || !publicKey || !program) return;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(row.optionMint!), publicKey, false, TOKEN_2022_PROGRAM_ID);
        const bal = await program.provider.connection.getTokenAccountBalance(ata);
        if (live) setHeld(Number(bal.value.amount));
      } catch { if (live) setHeld(0); }
    })();
    return () => { live = false; };
  }, [isSeries, row.optionMint, publicKey, program]);

  // USDC balance (dollars) — only needed for the Write collateral gate.
  useEffect(() => {
    let live = true;
    if (side !== "write" || !publicKey || !program) return;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, publicKey, false, TOKEN_PROGRAM_ID);
        const bal = await program.provider.connection.getTokenAccountBalance(ata);
        if (live) setUsdcBalance(Number(bal.value.uiAmount ?? 0));
      } catch { if (live) setUsdcBalance(0); }
    })();
    return () => { live = false; };
  }, [side, publicKey, program]);

  // BUG-1: derive remaining peg capacity from the focused vault (single-account
  // read — NOT a full scan). free = (total_collateral − early_exercise_payout) −
  // (total_options_minted − exercised_options) × collateral_per_token; remaining
  // contracts = floor(free / cpt). Only series (peg-backed) rows have a peg.
  useEffect(() => {
    let live = true;
    (async () => {
      if (!program || !isSeries) { if (live) setPegRemaining(null); return; }
      try {
        const v: any = await program.account.sharedVault.fetch(new PublicKey(row.vault));
        if (live) setVaultMarket((v.market as PublicKey).toBase58()); // needed by place_trigger
        const cpt = v.strikePrice.toNumber(); // collateral_per_token = strike
        const net = v.totalCollateral.toNumber() - (v.earlyExercisePayout?.toNumber?.() ?? 0);
        const liveContracts = v.totalOptionsMinted.toNumber() - (v.exercisedOptions?.toNumber?.() ?? 0);
        const free = net - liveContracts * cpt;
        if (live) setPegRemaining(cpt > 0 ? Math.max(0, Math.floor(free / cpt)) : null);
      } catch { if (live) setPegRemaining(null); }
    })();
    return () => { live = false; };
  }, [program, isSeries, row.vault]);

  // est. reference price off the cheap aggregate (Pass-0): ask for buy, bid for sell.
  const refPrice = side === "buy" ? row.bestAsk : row.bestBid;
  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);

  // Cheap mark (carry r=0) as the fallback reference + greeks input.
  const mark = useMemo(() => {
    if (!spot || spot <= 0 || days <= 0) return null;
    const vol = getDefaultVolatility(row.asset);
    const g = row.optionType === "call"
      ? calculateCallGreeks(spot, row.strike, days, applyVolSmile(vol, spot, row.strike, row.asset), 0)
      : calculatePutGreeks(spot, row.strike, days, applyVolSmile(vol, spot, row.strike, row.asset), 0);
    return g;
  }, [spot, days, row.asset, row.optionType, row.strike]);

  // Model-price fallback. European → EUR model (correct). American → ONLY the
  // on-chain quote; never the EUR model (structurally too low). `mark` itself is
  // untouched below — Greeks keep the European approximation (accepted).
  const modelPremium = useOnChainQuote ? (rfq?.premiumPerContract ?? null) : (mark?.premium ?? null);
  // For Buy, a live RFQ (protocol ask) takes precedence over the cheap aggregate.
  const estPrice = type === "limit"
    ? limitPrice
    : ((side === "buy" ? rfq?.premiumPerContract : undefined) ?? refPrice ?? modelPremium ?? null);
  const estTotal = estPrice != null ? estPrice * qty : null;

  // Readouts: λ elasticity, decay (θ/day), no-liquidation reminder. λ is a greek
  // (elasticity Δ·S/V): V MUST be the model premium the delta was computed
  // against — not the transaction price — else it's an incoherent hybrid.
  const lambda = mark && mark.premium > 0 ? (mark.delta * (spot ?? 0)) / mark.premium : null;
  const thetaPerDay = mark?.theta ?? null;

  // TP/SL is an EXIT for a position you already hold, so it is offered only when
  // there is something to exit. Underlying tape only in v1.
  const canTpSl = isSeries && (held ?? 0) > 0 && !!row.optionMint && !!vaultMarket;

  /** What the contract is worth IF the underlying reaches `atSpot` today.
   *  An ESTIMATE: it holds volatility fixed, assumes the trigger fires now (the
   *  figure decays as time-to-expiry shrinks), and is not the fill — execution
   *  goes through the book at whatever price is there. */
  const estAt = (atSpot: number): number | null => {
    if (!(atSpot > 0) || days <= 0) return null;
    // Volatility is left to the pricer's per-asset default (same source the
    // ticket's own mark uses), so the estimate and the λ/θ readouts stay
    // coherent rather than being two different models on one screen.
    const px = row.optionType === "call"
      ? calculateCallPremium(atSpot, row.strike, days, undefined, 0, undefined, row.asset)
      : calculatePutPremium(atSpot, row.strike, days, undefined, 0, undefined, row.asset);
    return px > 0 ? px * qty : null;
  };
  const tpEst = tpPrice > 0 ? estAt(tpPrice) : null;
  const slEst = slPrice > 0 ? estAt(slPrice) : null;

  // A trigger whose condition is ALREADY TRUE is valid on chain but is almost
  // never the intention: the keeper fires on its next tick and market-exits the
  // position the user thought they were protecting. See utils/triggerGuards.ts.
  const immediateLegs = type === "tpsl" ? alreadyMetLegs({ tpPrice, slPrice, spot }) : [];
  const immediateWarning = alreadyMetMessage(immediateLegs, spot);
  const immediateBlocks = immediateLegs.length > 0 && !confirmImmediate;

  // Pre-fill the limit price with the cheap mark when switching to Limit.
  useEffect(() => {
    if (type === "limit" && limitPrice === 0 && mark?.premium) setLimitPrice(Number(mark.premium.toFixed(4)));
  }, [type, mark]);

  const sellNoBalance = isSeries && side === "sell" && type === "limit" && (held ?? 0) < qty;

  async function submit() {
    setStatus(null);
    if (!publicKey) { setStatus({ kind: "err", msg: "Connect a wallet" }); return; }
    setBusy(true);
    setPhase(null);
    try {
      let sig: string | null = null;
      let phRoute: string | undefined; // buy·market dispatch route for analytics
      let removed: string[] = [];       // optimistically removed (fully-filled resting order)
      let added: BookOrder | undefined; // optimistically inserted (just-posted resting order)
      let sweepReport: string | null = null; // "Filled X of Y · avg $Z" for market sweeps
      // AUTHORITATIVE ADDRESS CHECK — before any assembly.
      //
      // The board renders from the indexer, and `row.vault` / `row.optionMint`
      // go straight into accountsStrict. An index row is a cache; a transaction
      // is not a place for cached addresses. So the series is re-read
      // chain-direct here and the row is checked against it.
      //
      // This is AUTHORITATIVE, not best-effort: a failure, a timeout or a
      // mismatch BLOCKS. It never falls back to the row's own addresses, because
      // the reason for reading is that the row might be wrong.
      const authoritative = await resolveAuthoritativeSeries(
        program!.provider.connection, program!.programId,
        { vault: row.vault, optionMint: row.optionMint! },
      );
      if (!authoritative.ok) {
        setStatus({ kind: "err", msg: authoritative.reason });
        setBusy(false);
        return;
      }

      const ref = { asset: row.asset, vault: authoritative.vault, optionMint: authoritative.optionMint };
      const nonce = Math.floor(Date.now() / 1000);
      const me = publicKey.toBase58();
      const optimisticOrder = (kind: "bid" | "resaleAsk" | "writerAsk", qtyOverride?: number): BookOrder => ({
        pubkey: deriveOrderPubkey(row.optionMint!, publicKey, nonce),
        owner: me, optionMint: row.optionMint!, vault: row.vault, kind,
        price: limitPrice, qty: qtyOverride ?? qty, qtyInitial: qtyOverride ?? qty, nonce: String(nonce),
        createdAt: Math.floor(Date.now() / 1000),
        collateralPerContract: kind === "writerAsk" ? row.strike : 0,
      });
      // Vault peg as an ask level (American-only + priced on-chain) when a fresh
      // quote + free capacity exist.
      const pegAsk = (useOnChainQuote && rfq?.premiumPerContract != null && (pegRemaining ?? 0) > 0)
        ? rfq.premiumPerContract : null;
      if (!isSeries) {
        if (side === "buy") { onLegacyBuy(row); setBusy(false); return; }
        setStatus({ kind: "err", msg: "Legacy listings are managed in Portfolio." });
        setBusy(false); return;
      }
      if (type === "tpsl") {
        // Placement is one transaction whether it is a pair or a single leg.
        // Sent through sendWithFreshBlockhash like every other path here — no
        // bare .rpc() is introduced (86eymw9m1 is about the existing ones).
        if (!program || !vaultMarket || !row.optionMint) {
          setStatus({ kind: "err", msg: "Series not ready" }); setBusy(false); return;
        }
        if (tpPrice <= 0 && slPrice <= 0) {
          setStatus({ kind: "err", msg: "Set a take-profit, a stop-loss, or both" });
          setBusy(false); return;
        }
        if (qty > (held ?? 0)) {
          setStatus({ kind: "err", msg: `You hold ${held ?? 0} contract(s)` });
          setBusy(false); return;
        }
        // Belt to the button's braces: an already-true trigger must not be armed
        // without the user having said so on purpose.
        if (immediateLegs.length > 0 && !confirmImmediate) {
          setStatus({ kind: "err", msg: immediateWarning });
          setBusy(false); return;
        }
        const usdc6 = (n: number) => new BN(Math.round(n * 1_000_000));
        const mkLeg = (
          kind: TriggerLeg["kind"], cmp: TriggerLeg["comparator"], px: number, n: number,
        ): TriggerLeg => ({
          kind, comparator: cmp,
          thresholdUsdc: usdc6(px), quantity: new BN(qty),
          minProceedsUsdc: usdc6(sellFloor), nonce: new BN(n),
        });
        const bundle = await buildTriggerPlacement(
          {
            program, owner: publicKey,
            market: new PublicKey(vaultMarket),
            sharedVault: new PublicKey(row.vault),
            optionMint: new PublicKey(row.optionMint),
            usdcMint: DEVNET_USDC_MINT,
          },
          {
            takeProfit: tpPrice > 0 ? mkLeg("takeProfitSell", "ge", tpPrice, nonce) : null,
            // +1 so a pair never shares a nonce: same nonce would derive the SAME
            // PDA and the "pair" would really be one order.
            stopLoss: slPrice > 0 ? mkLeg("stopLossSell", "le", slPrice, nonce + 1) : null,
          },
        );
        sig = await sendWithFreshBlockhash(
          program.provider as unknown as SendableProvider,
          () => {
            const tx = new Transaction();
            tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
            bundle.instructions.forEach((i) => tx.add(i));
            return tx;
          },
          { onPhase: setPhase },
        );
        setStatus({
          kind: "ok",
          msg: bundle.linked
            ? "TP/SL pair armed — one fires, the other is cancelled"
            : `${tpPrice > 0 ? "Take-profit" : "Stop-loss"} armed`,
        });
        // Broadcast so any mounted armed-exits list re-fetches. Without this the
        // list a user navigates to could still be showing the pre-placement set.
        emitMutation();
      } else if (side === "write") {
        // Write = mint-on-fill sell side: post a WriterAsk (escrows strike×qty USDC).
        sig = await post.submit(ref, "writerAsk", limitPrice, qty, nonce);
        if (sig) added = optimisticOrder("writerAsk");
      } else if (side === "buy" && type === "market") {
        // Multi-level sweep (Phase 1): [peg + resting asks] ascending, ≤4 levels
        // within slippage, in ONE tx. Self-trade: own asks filtered out.
        const levels = buildAskLevels(orders, row.optionMint!, me, pegAsk, pegRemaining ?? 0);
        const plan = planSweep({ side: "buy", qty, levels, slippagePct });
        if (!plan.legs.length) { setStatus({ kind: "err", msg: "No fillable liquidity within slippage." }); setBusy(false); return; }
        sig = await executeSweep(program!, ref, plan, slippagePct, undefined, setPhase);
        if (sig) {
          removed = plan.legs.filter((l) => l.order && l.qty >= l.capacity).map((l) => l.order!.pubkey);
          phRoute = plan.legs.map((l) => l.source).join("+");
          sweepReport = `Filled ${plan.filledQty} of ${qty}${plan.filledQty < qty ? " · partial" : ""} · avg ${plan.avgPrice != null ? fmt(plan.avgPrice) : "—"}`;
        }
      } else if (side === "buy" && type === "limit") {
        // Marketable (limit ≥ best ask) → CROSS (sweep ≤ limit), then rest residual
        // at the limit (TWO-TX). Below best ask → rest a bid unchanged.
        const askLevels = buildAskLevels(orders, row.optionMint!, me, pegAsk, pegRemaining ?? 0);
        const bestAsk = askLevels.length ? Math.min(...askLevels.map((l) => l.price)) : null;
        if (bestAsk == null || limitPrice < bestAsk) {
          sig = await post.submit(ref, "bid", limitPrice, qty, nonce);
          if (sig) added = optimisticOrder("bid");
        } else {
          const cross = await crossLimit(program!, ref, { side: "buy", qty, limitPrice, taker: me, optionMint: row.optionMint!, orders, pegAsk, pegCapacity: pegRemaining ?? 0, onPhase: setPhase });
          removed = cross.removed;
          const residual = qty - cross.filledQty;
          let restErr = false;
          if (residual > 0) {
            try { const rs = await post.submit(ref, "bid", limitPrice, residual, nonce); if (rs) { sig = rs; added = optimisticOrder("bid", residual); } }
            catch { restErr = true; }
          }
          if (!sig) sig = cross.sweepSigs[cross.sweepSigs.length - 1] ?? null;
          phRoute = "crossBuy";
          sweepReport = residual > 0
            ? (restErr
                ? `Filled ${cross.filledQty} of ${qty} · residual ${residual} failed to post — retry`
                : `Filled ${cross.filledQty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""} · rested ${residual} @ ${fmt(limitPrice)}`)
            : `Filled ${cross.filledQty} of ${qty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""}`;
        }
      } else if (side === "sell" && type === "market") {
        // Multi-level sweep into resting bids (descending), capped by held balance.
        const sellQty = Math.min(qty, held ?? 0);
        if (sellQty <= 0) { setStatus({ kind: "err", msg: "No contracts held to sell." }); setBusy(false); return; }
        const levels = buildBidLevels(orders, row.optionMint!, me);
        const plan = planSweep({ side: "sell", qty: sellQty, levels, slippagePct });
        if (!plan.legs.length) { setStatus({ kind: "err", msg: "No resting bid within slippage." }); setBusy(false); return; }
        sig = await executeSweep(program!, ref, plan, slippagePct, undefined, setPhase);
        if (sig) {
          removed = plan.legs.filter((l) => l.order && l.qty >= l.capacity).map((l) => l.order!.pubkey);
          phRoute = "sweepSell";
          sweepReport = `Sold ${plan.filledQty} of ${qty}${plan.filledQty < qty ? " · partial" : ""} · avg ${plan.avgPrice != null ? fmt(plan.avgPrice) : "—"}`;
        }
      } else if (side === "sell" && type === "limit") {
        if (sellNoBalance) { setBusy(false); return; }
        // Marketable (limit ≤ best bid) → CROSS into bids, then rest residual as a
        // resale ask at the limit (TWO-TX). Above best bid → rest unchanged.
        const bidLevels = buildBidLevels(orders, row.optionMint!, me);
        const bestBid = bidLevels.length ? Math.max(...bidLevels.map((l) => l.price)) : null;
        if (bestBid == null || limitPrice > bestBid) {
          sig = await post.submit(ref, "resaleAsk", limitPrice, qty, nonce);
          if (sig) added = optimisticOrder("resaleAsk");
        } else {
          const cross = await crossLimit(program!, ref, { side: "sell", qty, limitPrice, taker: me, optionMint: row.optionMint!, orders, pegAsk: null, pegCapacity: 0, onPhase: setPhase });
          removed = cross.removed;
          const residual = qty - cross.filledQty; // held ≥ qty (sellNoBalance gate) → residual is restable
          let restErr = false;
          if (residual > 0) {
            try { const rs = await post.submit(ref, "resaleAsk", limitPrice, residual, nonce); if (rs) { sig = rs; added = optimisticOrder("resaleAsk", residual); } }
            catch { restErr = true; }
          }
          if (!sig) sig = cross.sweepSigs[cross.sweepSigs.length - 1] ?? null;
          phRoute = "crossSell";
          sweepReport = residual > 0
            ? (restErr
                ? `Sold ${cross.filledQty} of ${qty} · residual ${residual} failed to post — retry`
                : `Sold ${cross.filledQty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""} · rested ${residual} @ ${fmt(limitPrice)}`)
            : `Sold ${cross.filledQty} of ${qty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""}`;
        }
      }
      if (sig) {
        setStatus({ kind: "ok", msg: sweepReport ? `${sweepReport} · ${sig.slice(0, 8)}…` : `Submitted · ${sig.slice(0, 8)}…` });
        const ev = side === "write" ? "trade_write_ask"
          : side === "buy" ? (type === "market" ? "trade_buy_market" : "trade_buy_limit")
          : (type === "market" ? "trade_sell_market" : "trade_sell_limit");
        posthog.capture(ev, {
          asset: row.asset, strike: row.strike, optionType: row.optionType, qty,
          price: type === "market" ? undefined : limitPrice, route: phRoute, sig,
        });
        // Two-layer refresh: optimistic (instant) + reconcile (chain truth) across
        // book, chain grid, and dock. onDone still refetches spot/legacy (td).
        refreshAfterMutation(program!, { removed, added });
        onDone();
      }
    } catch (e: any) {
      // A confirmation that timed out and then resolved to LANDED is a success
      // that took the slow road, not a failure. D2 still throws it — the
      // caller asked to confirm and we could not, so the optimistic path must
      // not continue as if it had — but the user's trade is on chain, and
      // telling them so in red while leaving their positions stale is how a
      // working buy comes to look like a broken one.
      const landed = e instanceof TxOutcomeError && e.outcome.kind === "landed";
      if (landed) {
        setStatus({ kind: "ok", msg: e.message });
        // Reconcile-only: this path has no trustworthy optimistic delta (the
        // throw happened inside the send, so `removed`/`added` never got set),
        // so we take chain truth for book, chain grid and dock, and let onDone
        // refresh balances, positions and open orders.
        if (program) refreshAfterMutation(program);
        onDone();
      } else {
        setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) });
      }
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  const submitting = busy || peg.submitting || post.submitting || fill.submitting || fillWA.submitting;

  // Elapsed seconds in the CURRENT phase. A button that reads "Submitting…"
  // unchanged for half a minute is indistinguishable from a hung one, which is
  // how a confirm that was merely slow got read as a failure. The counter only
  // appears once the wait is longer than a normal one, so the fast path stays
  // quiet.
  //
  // `phase` is a dependency on purpose: the count restarts at every transition,
  // so "Confirming… 8s" means eight seconds since the SEND, not eight seconds
  // since the click. A counter that accumulated across a 40 s wallet stall would
  // make a perfectly healthy confirm look like the slow one.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!submitting) {
      setElapsed(0);
      return;
    }
    const startedAt = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [submitting, phase]);
  // Never emit negative-zero ("$-0.0000" → "$0.0000").
  const fmt = (n: number) => {
    let s = n.toFixed(Math.abs(n) < 100 ? 4 : 2);
    if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1);
    return `$${s}`;
  };

  // Plug wave 1 write-gate (D2 condition 2): a source-2 market is write-closed
  // until its vol ring is warm. Read the market for source + feed, then the
  // oracle's sample_count; self-lifting at 168. Sources 0/1 are unaffected.
  const [writeMarket, setWriteMarket] = useState<{ feedIdHex: string; oracleSource: number } | null>(null);
  useEffect(() => {
    if (!isWrite || !program) { setWriteMarket(null); return; }
    let alive = true;
    (async () => {
      try {
        const marketPda = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(row.asset)], PROGRAM_ID)[0];
        const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
        if (alive) setWriteMarket({ feedIdHex: Buffer.from(mkt.pythFeedId as number[]).toString("hex"), oracleSource: Number(mkt.oracleSource ?? 0) });
      } catch {
        if (alive) setWriteMarket(null);
      }
    })();
    return () => { alive = false; };
  }, [isWrite, program, row.asset]);
  const writeFeeds = useMemo(() => (writeMarket ? [writeMarket.feedIdHex] : []), [writeMarket]);
  const writeOracle = useVolOracleStatus(writeFeeds);
  const warmupGate = !isWrite || !writeMarket ? null
    : writeWarmupGate(writeMarket.oracleSource, writeOracle.warmup.get(writeMarket.feedIdHex)?.sampleCount ?? null);

  // Write (WriterAsk) collateral gate — series+American only; collateral = strike × qty.
  const writeNeed = row.strike * qty;
  const writeGate = !isWrite ? null
    : !isSeries ? "Write is series-only"
    : row.exerciseStyle !== "american" ? "Writer-asks are American-only"
    : (usdcBalance != null && usdcBalance < writeNeed) ? `Insufficient USDC · need ${fmt(writeNeed)}`
    : !(limitPrice > 0) ? "Set an ask price"
    : warmupGate ? warmupGate
    : null;

  const limitGate = (!isWrite && type === "limit" && !(limitPrice > 0)) ? "Set a limit price" : null;

  // Does a BUY route to the vault PEG (model-priced) rather than filling purely
  // from resting maker asks? Only a peg-minting fill needs a fresh on-chain quote;
  // a fill that lands entirely on resting writer/resale asks executes at the
  // makers' FIXED prices and needs no model quote. Plan the sweep against resting
  // asks ONLY (peg excluded): if it can't cover the requested qty, the order
  // spills to the peg → model-priced → a fresh quote is required. This un-gates
  // writer-ask book fills while still guarding peg-minting buys.
  const meB58 = publicKey?.toBase58() ?? "";
  const buyNeedsPeg = useMemo(
    () =>
      side === "buy" && useOnChainQuote && !!row.optionMint &&
      buyRoutesToPeg({ orders, optionMint: row.optionMint, taker: meB58, type: type === "limit" ? "limit" : "market", limitPrice, qty, slippagePct }),
    [side, useOnChainQuote, row.optionMint, orders, meB58, type, limitPrice, qty, slippagePct],
  );

  // H-05: gate a MODEL-PRICED American commitment on a FRESH on-chain quote (never
  // the EUR model): a peg-routed buy, or a Write (posts against peg fair value). A
  // buy that fills purely on resting maker asks is NOT model-priced → never gated.
  const amerFresh = quoteFreshness(rfqLoading, rfqError, rfq);
  const needsFreshAmerQuote = useOnChainQuote && (side === "write" || buyNeedsPeg);
  const amerQuoteGate = needsFreshAmerQuote && !amerFresh.isFresh
    ? (amerFresh.statusReason ?? "Request an on-chain quote to continue")
    : null;

  // No peg-capacity button gate: the multi-level sweep routes a Buy·Market past
  // an exhausted peg to resting asks and reports an honest partial fill, so a
  // low peg no longer blocks the order.
  const disabled = submitting || sellNoBalance || !publicKey || (isWrite && !!writeGate) || !!limitGate || !!amerQuoteGate || immediateBlocks;

  return (
    <div className={docked ? "text-l-text" : "rounded-[10px] border border-l-hair bg-l-surface p-4 text-l-text"}>
      {/* Header — standalone only (docked inspector renders header/badges itself) */}
      {!docked && (
        <div className="mb-4 flex items-baseline justify-between">
          <div className="font-sans text-[16px] font-medium text-l-text">
            {row.asset} {fmtStrike(row.strike)} {row.optionType === "call" ? "Call" : "Put"}
          </div>
          <div
            className="font-mono-plex text-[9px] uppercase tracking-[0.16em]"
            style={{ color: row.provenance === "series" ? "var(--color-l-up)" : "var(--color-l-muted)" }}
          >
            {row.provenance}
          </div>
        </div>
      )}

      {/* Side — Buy / Sell / Write */}
      <Segment
        options={[["buy", "Buy"], ["sell", "Sell"], ["write", "Write"]]}
        value={side}
        onChange={(v) => setSide(v as Side)}
        colorVar={SIDE_VAR}
      />

      {/* Type — Market/Limit live, Stop/TP-SL gated. Hidden for Write (always a limit post). */}
      {!isWrite && (<>
        <div className="my-3 flex gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          {(["market", "limit", "stop", "tpsl"] as OrderType[]).map((t) => {
            // TP/SL is live once there is a position to exit. `stop` (StopEntryBuy)
            // stays gated: it is an ENTRY order and belongs to a later slice.
            const live = LIVE_TYPES.includes(t) || (t === "tpsl" && canTpSl);
            const label = t === "tpsl" ? "TP/SL" : t[0].toUpperCase() + t.slice(1);
            return (
              <button
                key={t}
                type="button"
                disabled={!live}
                onClick={() => live && setType(t)}
                title={live ? "" : t === "tpsl"
                  ? "TP/SL exits a position — you hold none of this contract yet"
                  : "Stop entry orders are a later slice"}
                className={`flex-1 px-2 py-2 font-mono-plex text-[10.5px] uppercase tracking-[0.14em] transition-colors ${
                  !live ? "cursor-not-allowed bg-l-surface text-l-faint"
                    : type === t ? "bg-l-surface-2 text-l-text" : "bg-l-surface text-l-muted hover:text-l-text"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {/* Honest inline state. TP/SL is live; Stop (StopEntryBuy) is a later slice. */}
        <p className="-mt-1 mb-3 font-mono-plex text-[9.5px] text-l-muted">
          {type === "tpsl"
            ? "Exits are watched by the keeper and fire on the underlying."
            : canTpSl
              ? "TP/SL is available for this position. Stop entry is a later slice."
              : "Stop · TP/SL — TP/SL needs a position in this contract to exit."}
        </p>
      </>)}


      {/* ── TP/SL pair form ──────────────────────────────────────────────
          Either field may be left EMPTY: that leg is simply not placed. A
          protective stop on its own is a legitimate order, so nothing here
          forces a take-profit to get a stop. Both filled ⇒ one atomic
          transaction that places both and links them (OCO), so a half-pair
          cannot exist. */}
      {type === "tpsl" && (
        <div className="mb-3 rounded-[6px] border border-l-hair bg-l-surface p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="font-mono-plex text-[9px] uppercase tracking-[0.2em] text-l-muted">
              Exit triggers
            </span>
            <span className="font-mono-plex text-[9.5px] text-l-faint">
              on {row.asset} · underlying
            </span>
          </div>

          {/* Spot is shown INSIDE the label. The walkthrough entry of 0.02 on a
              $0.5588 underlying happened because nothing on screen anchored
              these fields to the underlying's scale — the label said "JTO" and
              the user supplied a premium. */}
          <Field label={`Take profit — ${row.asset} at or above${spot != null ? ` · spot ${formatSpotForLabel(spot)}` : ""}`}>
            <NumericField
              value={tpPrice}
              min={0}
              fallback={0}
              placeholder={spotAnchoredPlaceholder("tp", spot)}
              onChange={setTpPrice}
              className="w-full bg-transparent font-mono-plex text-[13px] tabular-nums text-l-text outline-none"
            />
          </Field>
          {tpEst != null && (
            <p className={`-mt-2 mb-2 font-mono-plex text-[9.5px] ${isEffectivelyWorthless(tpEst) ? "text-l-down" : "text-l-muted"}`}>
              Est. value if hit today ≈ {fmt(tpEst)}
              {/* A bare "$0.0000" looks like a broken calculation. It is not —
                  the contract really would be worth nothing if the underlying
                  only reached that price — so say WHY and let the number read
                  as the warning it is. */}
              {isEffectivelyWorthless(tpEst) && " — worthless at that underlying price"}
            </p>
          )}

          <Field label={`Stop loss — ${row.asset} at or below${spot != null ? ` · spot ${formatSpotForLabel(spot)}` : ""}`}>
            <NumericField
              value={slPrice}
              min={0}
              fallback={0}
              placeholder={spotAnchoredPlaceholder("sl", spot)}
              onChange={setSlPrice}
              className="w-full bg-transparent font-mono-plex text-[13px] tabular-nums text-l-text outline-none"
            />
          </Field>
          {slEst != null && (
            <p className={`-mt-2 mb-2 font-mono-plex text-[9.5px] ${isEffectivelyWorthless(slEst) ? "text-l-down" : "text-l-muted"}`}>
              Est. value if hit today ≈ {fmt(slEst)}
              {isEffectivelyWorthless(slEst) && " — worthless at that underlying price"}
            </p>
          )}

          {/* FLOOR ASYMMETRY (found 2026-08-18). This floor is enforced on the
              BOOK sell path only — execute_trigger re-reads max_premium as a
              per-contract minimum and rejects a bid below it. The take-profit's
              VAULT fallback (american_exercise_core) has no floor check at all,
              so a TP can still exercise regardless of what is set here. The
              label said "minimum proceeds" without qualification, which promised
              more than one of the two paths delivers. Whether the floor SHOULD
              bind the vault path is a program-level question, queued for the next
              upgrade bundle. */}
          <Field label="Minimum proceeds per contract — book sales only">
            <NumericField
              value={sellFloor}
              min={0}
              fallback={0}
              placeholder="0 = no book sale (a take-profit can still exercise)"
              onChange={setSellFloor}
              className="w-full bg-transparent font-mono-plex text-[13px] tabular-nums text-l-text outline-none"
            />
          </Field>

          {/* ALREADY-MET GUARD. On chain this order is perfectly legal, so
              nothing downstream will stop it: the keeper simply fires on its
              next tick and market-exits the position. The only place this can
              be caught is here, against the user's intention. */}
          {immediateLegs.length > 0 && (
            <div className="mb-2 rounded-[6px] border border-l-down/50 bg-l-down/10 p-2">
              <p className="font-mono-plex text-[9.5px] leading-[1.5] text-l-down">
                {immediateWarning} It would be filled at the next keeper tick, exiting
                this position now — not protecting it.
              </p>
              <label className="mt-2 flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  checked={confirmImmediate}
                  onChange={(e) => setConfirmImmediate(e.target.checked)}
                  className="mt-[2px]"
                />
                <span className="font-mono-plex text-[9.5px] leading-[1.5] text-l-muted">
                  I want this to fire immediately
                </span>
              </label>
            </div>
          )}

          <p className="mt-1 font-mono-plex text-[9.5px] leading-[1.5] text-l-faint">
            Estimates hold today&rsquo;s volatility and time-to-expiry fixed and shrink as
            expiry approaches. They are not the fill — the exit is whatever the book pays.
            {sellFloor <= 0 && (
              <> <span className="text-l-muted">
                A floor of 0 blocks any BOOK sale. A stop-loss then cannot execute at
                all — it has no other route. A take-profit can still exercise against
                the vault if the contract is in the money, which ignores this floor.
              </span></>
            )}
          </p>

          {/* Contract-tape affordance — DISABLED in v1. The branch is live on
              chain but stays unreachable until one contract-tape fire is
              verified. Copy names no vendor and never says "market closed":
              what actually gates it is pricing-data freshness. */}
          <div className="mt-3 flex items-center gap-2 opacity-50">
            <input type="checkbox" disabled className="cursor-not-allowed" />
            <span className="font-mono-plex text-[9.5px] text-l-muted">
              Trigger on contract price instead — unavailable while pricing data is warming
            </span>
          </div>
        </div>
      )}

      {/* Qty + price */}
      <Field label="Quantity">
        <NumInput value={qty} min={1} step={1} integer onChange={(n) => setQty(Math.max(1, n || 1))} />
      </Field>

      {(type === "limit" || isWrite) && (
        <Field label={isWrite ? "Ask price · USDC / contract" : "Limit price · USDC / contract"}>
          <NumInput value={limitPrice} min={0} step={0.0001} onChange={(n) => setLimitPrice(Math.max(0, n || 0))} />
        </Field>
      )}
      {type === "market" && !isWrite && (
        <Field label="Max slippage %">
          <NumInput value={slippagePct} min={0} step={0.5} onChange={(n) => setSlippagePct(Math.max(0, n || 0))} />
        </Field>
      )}

      {/* Write — collateral to lock (strike × qty) + wallet USDC */}
      {isWrite && (
        <div className="my-3 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          <Stat label="Collateral to lock" value={fmt(writeNeed)} sub="strike × qty" />
          <Stat label="Your USDC" value={<span data-ph-mask>{usdcBalance != null ? fmt(usdcBalance) : "…"}</span>} />
        </div>
      )}

      {!isWrite && (<>
        {/* Est price / total */}
        <div className="my-3 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          <Stat label={side === "buy" ? "Est. ask" : "Est. bid"} value={estPrice != null ? fmt(estPrice) : "—"} />
          <Stat label="Est. total" value={estTotal != null ? fmt(estTotal) : "—"} />
        </div>

        {/* λ / θ + no-liquidation badge (teal outline) */}
        <div className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          <Stat label="λ leverage" value={lambda != null ? `${lambda.toFixed(1)}×` : "—"} />
          <Stat label="θ decay / day" value={thetaPerDay != null ? fmt(thetaPerDay) : "—"} />
        </div>
        <div
          className="mb-3 flex items-center gap-[8px] rounded-[6px] border px-[11px] py-[8px]"
          style={{ borderColor: "var(--color-l-up)" }}
        >
          <span className="h-[6px] w-[6px] flex-none rounded-full" style={{ background: "var(--color-l-up)" }} />
          <span className="font-mono-plex text-[10.5px] text-l-text">No liquidation — max loss = premium</span>
        </div>
      </>)}

      {/* RFQ request block — standalone only. In docked mode the inspector renders
          the protocol-quote centerpiece + request/re-quote and seeds this ticket. */}
      {!docked && (useOnChainQuote ? (
        <div className="mb-3">
          <button type="button" onClick={requestQuote} disabled={rfqLoading}
            className="w-full rounded-[6px] border border-l-hair py-2 font-mono-plex text-[10.5px] uppercase tracking-[0.16em] text-l-text transition-colors hover:bg-l-surface disabled:cursor-wait disabled:opacity-50">
            {rfqLoading ? "Pricing on-chain…" : rfq ? "Re-quote" : "Request on-chain quote"}
          </button>
          {(rfq || rfqError) && (
            <div className="mt-2">
              {rfq && (
                <div className="font-mono-plex text-[13px] tabular-nums text-l-text">
                  Protocol quote · {fmt(rfq.premiumPerContract)}/contract · total {fmt(rfq.premiumPerContract * qty)}
                </div>
              )}
              <div className="mt-0.5 font-mono-plex text-[9.5px] text-l-muted">
                {describeOptionPriceQuoteStatus(rfqLoading, rfqError, rfq)}
              </div>
            </div>
          )}
        </div>
      ) : (!isWrite && (
        <button type="button" disabled title="On-chain quote is American-only; EUR uses the model price"
          className="mb-3 w-full cursor-not-allowed rounded-[6px] border border-l-hair py-2 font-mono-plex text-[10.5px] uppercase tracking-[0.16em] text-l-faint">
          Model price · EUR
        </button>
      )))}

      {/* Submit — the single teal-fill primary action */}
      <button type="button" disabled={disabled} onClick={submit}
        className={`w-full rounded-[6px] py-3 font-sans text-[13px] font-medium transition-opacity ${
          disabled ? "cursor-not-allowed bg-l-surface-2 text-l-muted" : "bg-l-up text-l-on-up hover:opacity-90"
        }`}>
        {!publicKey ? "Connect wallet"
          : submitting ? submitLabel(phase, elapsed)
          : isWrite ? (writeGate ?? amerQuoteGate ?? `Write ${qty} · ask ${fmt(limitPrice)}`)
          : limitGate ? limitGate
          : amerQuoteGate ? amerQuoteGate
          : sellNoBalance ? "No contracts held to sell"
          // TP/SL places ORDERS, it does not sell anything now. The generic
          // label fell through to fmt(limitPrice) — unused in this mode — and
          // rendered "Sell 3 · $0.0000", which reads as a zero-dollar market
          // sell. No price belongs on this button: the exit price is whatever
          // the book pays when the trigger eventually fires.
          : type === "tpsl" ? (immediateBlocks ? "Confirm immediate fire to continue" : `Arm exits · ${qty}`)
          : `${side === "buy" ? "Buy" : "Sell"} ${qty} · ${type === "market" ? "Market" : fmt(limitPrice)}`}
      </button>

      {phase === "resigning" && (
        <p className="mt-2 font-mono-plex text-[9.5px] text-l-muted">
          The approval outlived its blockhash — a second wallet prompt is open. Re-sign to continue; nothing was charged.
        </p>
      )}

      {isSeries && side === "sell" && type === "limit" && (
        <p className="mt-2 font-mono-plex text-[9.5px] text-l-muted">
          Sell·Limit lists held contracts (resale). Held: {held ?? "…"}.
        </p>
      )}
      {!isSeries && (
        <p className="mt-2 font-mono-plex text-[9.5px] text-l-muted">
          Legacy contract — Buy routes to the classic vault/resale flow; sell-side listing lives in Portfolio.
        </p>
      )}

      {status && (
        <p className="mt-3 font-mono-plex text-[10.5px]" style={{ color: status.kind === "ok" ? "var(--color-l-up)" : "var(--color-l-down)" }}>
          {status.msg}
        </p>
      )}
    </div>
  );
};

/** Seconds in the current phase before the submit button starts showing its
 *  elapsed count. A healthy confirm lands inside a second, so anything past this
 *  is worth narrating rather than leaving as a static label. */
const PENDING_HINT_S = 5;

/**
 * What the button says while an order is in flight.
 *
 * One rule: never claim a step that has not happened. "Confirming" requires a
 * signature on the network; "Submitting" requires the user to have signed. The
 * long wait on this page is `awaiting` — the wallet holding its own prompt — and
 * naming it is the whole point, because the user can act on "your wallet is
 * waiting for you" and can do nothing at all about "confirming on chain".
 */
function submitLabel(phase: SendPhase | null, elapsed: number): string {
  const secs = elapsed >= PENDING_HINT_S ? ` ${elapsed}s` : "";
  switch (phase) {
    case "preparing": return "Preparing order…";
    case "awaiting": return `Awaiting wallet approval…${secs}`;
    case "resigning": return "Approval expired — re-sign to continue";
    case "submitting": return "Submitting…";
    case "confirming": return `Confirming…${secs}`;
    // The .rpc() paths (post / fill / cancel) do not report phases yet — see the
    // follow-up slice. Their unchanged label keeps them honest rather than
    // borrowing a phase they never emitted.
    default: return "Submitting…";
  }
}

const fmtStrike = (n: number): string => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n));

const Segment: FC<{
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
  colorVar?: Record<string, string>;
}> = ({ options, value, onChange, colorVar }) => (
  <div className="flex gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
    {options.map(([v, label]) => {
      const selected = value === v;
      const cv = colorVar?.[v];
      return (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={`flex-1 px-3 py-2 font-sans text-[12px] font-medium transition-colors ${
            selected ? "text-l-text" : "bg-l-surface text-l-muted hover:text-l-text"
          }`}
          style={selected ? {
            background: cv ? `color-mix(in srgb, var(${cv}) 14%, transparent)` : undefined,
            color: cv && cv !== "--color-l-text" ? `var(${cv})` : undefined,
          } : undefined}>
          {label}
        </button>
      );
    })}
  </div>
);

const Field: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="mb-3">
    <div className="mb-1.5 font-mono-plex text-[9.5px] uppercase tracking-[0.14em] text-l-muted">{label}</div>
    {children}
  </div>
);

/** Kept as a name so call sites are untouched, but the behaviour now comes from
 *  the shared NumericField: the old body stored a parsed number, so clearing it
 *  produced Number("") === 0 and the field snapped back. `step` is accepted and
 *  ignored — it only ever drove type="number" spinners, which are gone. */
const NumInput: FC<{ value: number; min: number; step: number; integer?: boolean; onChange: (n: number) => void }> = ({ value, min, integer, onChange }) => (
  <NumericField
    value={value}
    min={min}
    integer={integer}
    fallback={min}
    onChange={onChange}
    className="w-full rounded-[6px] border border-l-hair bg-transparent px-3 py-2 font-mono-plex text-[14px] tabular-nums text-l-text outline-none transition-colors focus:border-l-muted"
  />
);

const Stat: FC<{ label: string; value: ReactNode; sub?: string }> = ({ label, value, sub }) => (
  <div className="bg-l-surface p-3">
    <div className="mb-1.5 font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">{label}</div>
    <div className="font-mono-plex text-[15px] leading-none tabular-nums text-l-text">{value}</div>
    {sub && <div className="mt-1 font-mono-plex text-[8.5px] uppercase tracking-[0.12em] text-l-muted">{sub}</div>}
  </div>
);
