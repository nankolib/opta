import type { FC, ReactNode, CSSProperties } from "react";
import { Fade } from "../../components/ui";
import { SectionNumber } from "../../components/layout";
import { OrbitalDiagram } from "./orbital/OrbitalDiagram";

/**
 * § 02 — The Living Option Token.
 *
 * Title + blurb up top, the orbital diagram in the middle, and
 * three mechanics columns below (Pricing / Settlement / Composable).
 * The three mechanics render through a small <Mech> sub-component
 * so the body shape stays uniform.
 */
export const ProductSection: FC = () => (
  <section id="product" className="relative py-[clamp(80px,14vh,180px)]">
    {/* dotted background field with elliptical mask */}
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 opacity-70"
      style={{
        backgroundImage: "radial-gradient(rgba(10,10,8,.18) 1px, transparent 1.4px)",
        backgroundSize: "22px 22px",
        maskImage:
          "radial-gradient(ellipse at 50% 40%, black 0%, transparent 70%)",
        WebkitMaskImage:
          "radial-gradient(ellipse at 50% 40%, black 0%, transparent 70%)",
      }}
    />

    <div className="relative z-[2] mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)]">
      <Fade className="mb-12">
        <SectionNumber number="02" label="The product" />
      </Fade>

      <div className="grid grid-cols-1 md:grid-cols-2 items-end gap-12 mb-[clamp(48px,8vh,96px)]">
        <Fade
          as="h2"
          className="m-0 font-fraunces-display font-light leading-none tracking-[-0.025em] text-[clamp(40px,5.6vw,80px)]"
        >
          The <em className="italic font-fraunces-display-em">Living Option</em>
          <br />
          Token.
        </Fade>
        <Fade
          as="p"
          className="font-fraunces-text italic font-light leading-[1.55] opacity-85 max-w-[42ch] text-[clamp(17px,1.4vw,20px)]"
        >
          Strike, expiry, and settlement are written into the asset
          itself. A single SPL token under the Token-2022 standard,
          behaving like an option and clearing like an option —
          without protocol surface area between holder and contract.
        </Fade>
      </div>

      <OrbitalDiagram />

      <div className="grid grid-cols-1 md:grid-cols-3 border-t border-rule mt-[clamp(48px,8vh,96px)]">
        <Mech
          roman="I."
          headline={
            <>
              <em className="italic font-fraunces-mid-em">Pricing</em>, on-chain.
            </>
          }
          body="Black–Scholes computed natively via solmath. EWMA volatility from Pyth feeds, with smile correction. No off-chain oracle, no marker latency."
          tag="Solmath · Pyth · EWMA"
          staggerIndex={0}
        />
        <Mech
          roman="II."
          headline={
            <>
              <em className="italic font-fraunces-mid-em">Settlement</em>, automatic.
            </>
          }
          body="Token-2022 TransferHook enforces expiry. PermanentDelegate clears at the strike. The token settles itself; there is no claim window to manage."
          tag="Token-2022 · TransferHook"
          staggerIndex={1}
        />
        <Mech
          roman="III."
          headline={
            <>
              <em className="italic font-fraunces-mid-em">Composable</em> by design.
            </>
          }
          body="Because each option is an SPL token, every Solana primitive — lending, collateral, structured products — inherits options as a first-class asset."
          tag="SPL · Lending · Vaults"
          staggerIndex={2}
          last
        />
      </div>
    </div>
  </section>
);

type MechProps = {
  roman: string;
  headline: ReactNode;
  body: string;
  tag: string;
  staggerIndex: number;
  last?: boolean;
};

const Mech: FC<MechProps> = ({ roman, headline, body, tag, staggerIndex, last }) => {
  const borderClass = last
    ? "border-b border-rule md:border-b-0 md:border-r-0"
    : "border-b border-rule md:border-b-0 md:border-r md:border-rule";
  const styleVar: CSSProperties = { ["--i" as never]: staggerIndex };

  return (
    <article
      className={`relative px-[28px] py-[32px] pb-[36px] ${borderClass}`.trim()}
      style={styleVar}
    >
      <Fade className="opta-stag">
        <div className="font-fraunces-text italic font-light text-[18px] tracking-[0.04em] opacity-55 mb-6">
          {roman}
        </div>
        <h3 className="font-fraunces-mid font-light leading-[1.05] tracking-[-0.02em] text-[clamp(28px,2.8vw,38px)] m-0 mb-4">
          {headline}
        </h3>
        <p className="text-[15px] leading-[1.6] text-ink opacity-78 max-w-[32ch] m-0">
          {body}
        </p>
        <span className="block mt-6 font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-55">
          {tag}
        </span>
      </Fade>
    </article>
  );
};

export default ProductSection;
