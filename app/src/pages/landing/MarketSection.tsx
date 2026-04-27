import type { FC, ReactNode, CSSProperties } from "react";
import { useRef } from "react";
import { Reveal, Fade } from "../../components/ui";
import { SectionNumber, MetaLabel } from "../../components/layout";
import { useParticleField } from "../../hooks/useParticleField";
import { useLandingNav } from "./landingNavContext";

/**
 * § 03 — The Unlock. The dark inversion section.
 *
 * Houses the canvas particle field (driven by useParticleField),
 * two drifting nebula gradients, the scanline sweep, and the
 * 4-cell market-stat grid.
 *
 * Hosts the nav-over-dark sentinel: a 1px-tall span at the very
 * top of the section, attached via the LandingNav context's
 * `setSentinelRef`. MarketSection deliberately does not import
 * useNavOverDark — the hook is owned by the LandingPage and
 * MarketSection just hosts the sentinel that drives it.
 */
export const MarketSection: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { setSentinelRef } = useLandingNav();
  useParticleField(canvasRef);

  return (
    <section
      id="market"
      className="relative isolate overflow-hidden bg-ink text-paper py-[clamp(100px,18vh,200px)]"
    >
      {/* nav-over-dark sentinel — spans the full section so the
          IntersectionObserver's "in band" state persists for the
          duration of the dark section being behind the nav, not
          just the single-frame moment a 1px-top sentinel crosses
          the rootMargin band. Functionally equivalent to observing
          the section element itself, but keeps the setSentinelRef
          contract (a discrete element, not the section) intact. */}
      <span
        ref={setSentinelRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
      />

      {/* nebula gradients */}
      <div aria-hidden="true" className="pointer-events-none absolute -inset-[20%] z-0">
        <div
          className="absolute inset-0 will-change-transform animate-neb-drift-1 [filter:blur(40px)]"
          style={{
            background:
              "radial-gradient(60% 50% at 30% 30%, rgba(215,38,61,.18), transparent 60%), radial-gradient(50% 60% at 70% 70%, rgba(215,38,61,.10), transparent 60%), radial-gradient(70% 60% at 80% 20%, rgba(40,217,194,.06), transparent 70%)",
          }}
        />
        <div
          className="absolute inset-0 will-change-transform animate-neb-drift-2 [filter:blur(40px)]"
          style={{
            background:
              "radial-gradient(40% 50% at 50% 80%, rgba(215,38,61,.16), transparent 60%), radial-gradient(60% 40% at 20% 60%, rgba(241,236,226,.04), transparent 70%)",
          }}
        />
      </div>

      {/* scanline */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 z-[1] h-px animate-scan"
        style={{
          background:
            "linear-gradient(to right, transparent, rgba(215,38,61,.55), transparent)",
        }}
      />

      {/* canvas particle field */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[1]"
      />

      <div className="relative z-[2] mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)]">
        <Fade className="mb-[clamp(60px,10vh,120px)] text-paper">
          <SectionNumber number="03" label="The unlock" tone="paper" />
        </Fade>

        {/* No max-width on the headline wrapper: each Reveal renders as
            display:block (one line per Reveal), so natural line breaks
            handle the layout. v3's `max-width: 18ch` resolves against
            body sans metrics, not display metrics, and clips the
            headline at large breakpoints. */}
        <div className="mb-[clamp(60px,10vh,120px)]">
          <h2 className="m-0 font-fraunces-display font-light leading-[0.98] tracking-[-0.03em] text-paper text-[clamp(44px,7vw,104px)]">
            <Reveal as="span" className="block">
              The largest
            </Reveal>
            <Reveal as="span" className="block">
              <em className="italic font-fraunces-display-em text-crimson [text-shadow:0_0_30px_rgba(215,38,61,.45),0_0_80px_rgba(215,38,61,.25)]">
                missing
              </em>{" "}
              market
            </Reveal>
            <Reveal as="span" className="block">
              in digital&nbsp;finance.
            </Reveal>
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-paper/10">
          <MarketCell
            label="Notional · Global derivatives"
            big={
              <>
                $846<em className="italic font-fraunces-display-em">trn</em>
              </>
            }
            sub="The asset class options sit inside. Crypto has not yet built its own."
            staggerIndex={0}
          />
          <MarketCell
            label="Solana share · On-chain spot, Q1 '26"
            big={
              <>
                41<em className="italic font-fraunces-display-em">%</em>
              </>
            }
            sub="The venue institutional capital is already on. BlackRock, Goldman, Citi. The hedge is the only thing missing."
            staggerIndex={1}
          />
          <MarketCell
            label="Institutional capital · On Solana"
            big={
              <>
                $550M<em className="italic font-fraunces-display-em">+</em>
              </>
            }
            sub="BlackRock BUIDL on Solana alone, plus Goldman SOL holdings and Citi trade-finance settlement."
            staggerIndex={2}
          />
          <MarketCell
            label="Native options · Pre-Opta"
            big={<em className="italic font-fraunces-display-em text-crimson">0</em>}
            sub="Solana options protocols clearing institutional volume, prior to launch."
            staggerIndex={3}
          />
        </div>

        <div className="mt-[clamp(60px,10vh,100px)] flex flex-wrap items-end justify-between gap-5 border-t border-paper/15 pt-7">
          <Fade
            as="p"
            className="font-fraunces-text italic font-light leading-[1.5] opacity-85 max-w-[50ch] text-[clamp(18px,1.6vw,24px)]"
          >
            <strong className="not-italic font-medium text-paper opacity-100">
              Institutions cannot allocate to assets they cannot hedge.
            </strong>{" "}
            That sentence has held back trillions in capital from on-chain
            markets. Opta is not a trading venue. It is the infrastructure
            that makes Solana{" "}
            <em className="italic text-crimson">institutionally complete</em>{" "}
            — the layer beneath every fund, treasury, and structured
            product that wants the throughput without the unhedged exposure.
          </Fade>
          <MetaLabel tone="paper">
            Sources: Blockworks Advisory Q1 2026 · BIS Q4 2025 · Public institutional disclosures
          </MetaLabel>
        </div>
      </div>
    </section>
  );
};

type MarketCellProps = {
  label: string;
  big: ReactNode;
  sub: string;
  staggerIndex: number;
};

const MarketCell: FC<MarketCellProps> = ({ label, big, sub, staggerIndex }) => {
  const styleVar: CSSProperties = { ["--i" as never]: staggerIndex };
  return (
    <div style={styleVar}>
      <Fade className="opta-stag bg-ink/55 [backdrop-filter:blur(8px)] [-webkit-backdrop-filter:blur(8px)] px-6 pt-8 pb-7 flex flex-col justify-between min-h-[220px]">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-55 mb-6">
          {label}
        </div>
        <div>
          <div className="font-fraunces-display font-light leading-[0.95] tracking-[-0.03em] text-[clamp(40px,4.6vw,64px)]">
            {big}
          </div>
          <p className="mt-3.5 text-[13.5px] leading-[1.55] opacity-66 max-w-[28ch] m-0">
            {sub}
          </p>
        </div>
      </Fade>
    </div>
  );
};

export default MarketSection;
