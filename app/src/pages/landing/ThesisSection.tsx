import type { FC, ReactNode, CSSProperties } from "react";
import { Fade, Strike, Tracer } from "../../components/ui";
import { SectionNumber, MetaLabel } from "../../components/layout";

/**
 * § 01 — The Infrastructure Gap.
 *
 * The animated tracer with five tick marks and a right-aligned mono
 * end-label sits at the top of the section. The two-column body is
 * a long-form thesis statement (with an animated strikethrough on
 * "credible institutional scale") opposite three large stat blocks.
 * The third stat is the "0" — italic crimson, the visual punch of
 * the section.
 *
 * Stagger on the three stats uses the `opta-stag` helper class plus
 * an inline `--i` CSS variable set on a thin wrapper around each
 * Fade. The wrapper pattern avoids extending Fade's contract just
 * to pass `--i`; CSS resolves the variable from any ancestor.
 */
export const ThesisSection: FC = () => (
  <section
    id="thesis"
    className="relative border-t border-rule py-[clamp(80px,14vh,160px)]"
  >
    {/* tracer line + ticks + end label */}
    <div className="absolute inset-x-0 top-[92px] h-px pointer-events-none">
      <Tracer />
      <span aria-hidden="true" className="absolute -top-[3px] left-0 h-[7px] w-px bg-ink opacity-35" />
      <span aria-hidden="true" className="absolute -top-[3px] left-1/4 h-[7px] w-px bg-ink opacity-35" />
      <span aria-hidden="true" className="absolute -top-[3px] left-1/2 h-[7px] w-px bg-ink opacity-35" />
      <span aria-hidden="true" className="absolute -top-[3px] left-3/4 h-[7px] w-px bg-ink opacity-35" />
      <span aria-hidden="true" className="absolute -top-[3px] right-0 h-[7px] w-px bg-ink opacity-35" />
      <MetaLabel
        tone="muted"
        className="absolute -top-[22px] right-[clamp(20px,4vw,56px)]"
      >
        41% — Solana share, on-chain spot · Q1 '26
      </MetaLabel>
    </div>

    <div className="relative z-[2] mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)]">
      <Fade className="mb-12">
        <SectionNumber number="01" label="The infrastructure gap" />
      </Fade>

      <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr] gap-[clamp(40px,6vw,96px)] items-start">
        <Fade
          as="p"
          className="font-fraunces-mid font-light text-ink leading-[1.08] tracking-[-0.02em] text-[clamp(32px,4.2vw,56px)]"
        >
          Solana now clears 41% of on-chain spot volume — and holds
          institutional capital from BlackRock, Goldman, and Citi at
          meaningful scale. Yet the single primitive every desk
          depends on to take risk — the{" "}
          <em className="italic font-fraunces-mid-em">option</em> —
          does not exist on this chain at{" "}
          <Strike>credible institutional scale</Strike>. Capital
          cannot allocate to assets it cannot hedge.
        </Fade>

        <div className="flex flex-col gap-6">
          <Stat
            label="On-chain spot volume cleared on Solana, Q1 2026"
            num="41"
            unit="%"
            staggerIndex={0}
          />
          <Stat
            label="Global derivatives notional, BIS 2026"
            num="$846"
            unit="trn"
            staggerIndex={1}
          />
          <Stat
            label={
              <>
                Solana options protocols clearing{" "}
                <span className="text-crimson">institutional</span>{" "}
                volume, prior to Opta
              </>
            }
            num="0"
            staggerIndex={2}
            zero
          />
        </div>
      </div>
    </div>
  </section>
);

type StatProps = {
  label: ReactNode;
  num: string;
  unit?: string;
  staggerIndex: number;
  zero?: boolean;
};

const Stat: FC<StatProps> = ({ label, num, unit, staggerIndex, zero }) => {
  const lastBorderClass = staggerIndex === 2 ? "border-b border-rule pb-6" : "";
  const numClass = zero
    ? "italic text-crimson font-fraunces-display-em"
    : "font-fraunces-display";
  const styleVar: CSSProperties = { ["--i" as never]: staggerIndex };

  return (
    <div style={styleVar}>
      <Fade
        className={`opta-stag border-t border-rule pt-6 grid grid-cols-[1fr_auto] gap-4 items-end ${lastBorderClass}`.trim()}
      >
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink opacity-70 max-w-[30ch] leading-[1.6] self-end">
          {label}
        </div>
        <div
          className={`text-right whitespace-nowrap leading-[0.9] tracking-[-0.04em] text-[clamp(56px,8vw,104px)] font-light ${numClass}`}
        >
          {num}
          {unit && (
            <span className="text-[0.34em] font-mono uppercase tracking-[0.16em] opacity-60 align-[0.55em] ml-1">
              {unit}
            </span>
          )}
        </div>
      </Fade>
    </div>
  );
};

export default ThesisSection;
