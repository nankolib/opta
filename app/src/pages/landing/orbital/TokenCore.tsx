import type { FC } from "react";

/**
 * The token core — a dark circular disc at the center of the
 * orbital diagram, displaying the italic "opta·" wordmark in paper
 * cream.
 *
 * Wordmark isn't reused here because the core uses a `clamp(28px,
 * 4vw, 44px)` size that doesn't match either of Wordmark's sm
 * (22px) or lg (64px) presets, and lives on a dark surface where
 * the wordmark dot is decorative crimson punctuation rather than
 * the color-aware WordmarkDot. Inlining the markup keeps the
 * component-internal sizing local rather than bloating Wordmark's
 * preset list.
 */
export const TokenCore: FC = () => (
  <div
    className="absolute inset-[38%] flex items-center justify-center overflow-hidden rounded-full bg-ink [box-shadow:0_30px_80px_-20px_rgba(10,10,8,.45),inset_0_0_0_1px_rgba(241,236,226,.05)]"
  >
    {/* inner highlight gradient */}
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{
        background:
          "radial-gradient(circle at 30% 25%, rgba(241,236,226,.12), transparent 40%), radial-gradient(circle at 70% 80%, rgba(215,38,61,.18), transparent 50%)",
      }}
    />
    {/* inner ring */}
    <span
      aria-hidden="true"
      className="absolute inset-[8%] rounded-full border border-paper/15"
    />
    {/* glyph */}
    <span className="relative font-fraunces-mid-em italic font-normal text-paper tracking-[-0.02em] text-[clamp(28px,4vw,44px)]">
      opta
      <span
        aria-hidden="true"
        className="ml-1 inline-block h-[6px] w-[6px] -translate-y-[0.5em] rounded-full bg-crimson"
      />
    </span>
  </div>
);

export default TokenCore;
