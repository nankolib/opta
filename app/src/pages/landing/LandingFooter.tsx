import type { FC } from "react";
import { Wordmark } from "../../components/brand";
import { HairlineRule } from "../../components/layout";

/**
 * Footer — the large "opta·" wordmark and tagline anchor a four-
 * column link grid; a HairlineRule separates the grid from a small
 * meta row at the bottom (copyright + legal links).
 *
 * Footer links are placeholder href="#" anchors for now (plain <a>,
 * not <Link> — # in a Router Link triggers a navigation attempt).
 * Phase 2 wires real destinations.
 */
export const LandingFooter: FC = () => (
  <footer className="border-t border-rule pt-[clamp(60px,8vh,100px)] pb-10">
    <div className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)]">
      <div className="grid grid-cols-2 md:grid-cols-[1.4fr_1fr_1fr_1fr] gap-10 items-start mb-20">
        <div className="col-span-2 md:col-span-1">
          <Wordmark size="lg" />
          <p className="mt-[22px] font-fraunces-text italic font-light leading-[1.55] opacity-70 max-w-[36ch] text-[16px]">
            An options layer for Solana. Token-2022 native. Built for
            the desks that price risk for a living.
          </p>
        </div>
        <FooterColumn
          title="Product"
          links={[
            ["Living Option Token", "#"],
            ["Pricing engine", "#"],
            ["Settlement", "#"],
            ["Whitepaper", "#"],
          ]}
        />
        <FooterColumn
          title="Build"
          links={[
            ["Documentation", "#"],
            ["SDK · TypeScript", "#"],
            ["Rust crate", "#"],
            ["Audits", "#"],
          ]}
        />
        <FooterColumn
          title="Company"
          links={[
            ["Research", "#"],
            ["Team", "#"],
            ["Careers", "#"],
            ["Contact", "#"],
          ]}
        />
      </div>

      <HairlineRule />

      <div className="flex flex-wrap items-center justify-between gap-[14px] pt-7 font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-60">
        <span>© 2026 Opta Labs · Built on Solana</span>
        <span className="flex flex-wrap gap-[18px]">
          <a href="#">Terms</a>
          <a href="#">Privacy</a>
          <a href="#">Disclosures</a>
        </span>
      </div>
    </div>
  </footer>
);

type FooterColumnProps = {
  title: string;
  links: ReadonlyArray<readonly [string, string]>;
};

const FooterColumn: FC<FooterColumnProps> = ({ title, links }) => (
  <div>
    <h5 className="font-mono text-[10.5px] uppercase tracking-[0.22em] m-0 mb-4 opacity-50 font-medium">
      {title}
    </h5>
    <ul className="list-none p-0 m-0 flex flex-col gap-[10px]">
      {links.map(([label, href]) => (
        <li key={label}>
          <a
            href={href}
            className="text-[14px] opacity-85 transition-opacity duration-300 ease-opta hover:opacity-100 no-underline"
          >
            {label}
          </a>
        </li>
      ))}
    </ul>
  </div>
);

export default LandingFooter;
