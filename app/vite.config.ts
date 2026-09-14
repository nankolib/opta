import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { SECTIONS } from "./src/pages/docs/sections";

const SLICE_QUERY = "?slice";

/**
 * opta-whitepaper-slicer — build-time markdown slicer for /docs.
 *
 * Imports of the form `import doc from "<path>.md?slice"` resolve to a
 * virtual ESM module exporting `{ abstract, sections }`. The abstract
 * is the prose between the document's first two `---` HR rules; the
 * sections map is keyed by slug (positional zip with SECTIONS) and
 * contains everything from after each top-level heading up to (but
 * not including) the next.
 *
 * Top-level heading regex: `^## (\d+\. .+|Appendix [A-C] — .+)$`.
 * The subtitle and TOC headings (`## The Options Primitive...`,
 * `## Table of Contents`) are filtered out by this pattern. If the
 * whitepaper drifts so the count != 16, the plugin throws a clear
 * error at module-load time, which Vite surfaces as a build failure.
 *
 * `addWatchFile` registers the source `.md` so dev-mode HMR
 * regenerates the virtual module when the whitepaper edits.
 */
function whitepaperSlicer(): Plugin {
  return {
    name: "opta-whitepaper-slicer",
    enforce: "pre",
    resolveId(source, importer) {
      if (!source.endsWith(SLICE_QUERY) || !importer) return null;
      const cleanSource = source.slice(0, -SLICE_QUERY.length);
      if (!cleanSource.endsWith(".md")) return null;
      const importerDir = path.dirname(importer);
      const fullPath = path.resolve(importerDir, cleanSource);
      return fullPath + SLICE_QUERY;
    },
    load(id) {
      if (!id.endsWith(SLICE_QUERY)) return null;
      const filePath = id.slice(0, -SLICE_QUERY.length);
      if (!filePath.endsWith(".md")) return null;

      const content = fs.readFileSync(filePath, "utf-8");
      const slugs = SECTIONS.map((s) => s.slug);
      const doc = sliceWhitepaper(content, slugs);
      this.addWatchFile(filePath);
      return `export default ${JSON.stringify(doc)};`;
    },
  };
}

function sliceWhitepaper(
  content: string,
  expectedSlugs: readonly string[],
): { abstract: string; sections: Record<string, string> } {
  // ---- Abstract: prose between the first two `---` HR rules ----
  const HR = "\n---\n";
  const firstHr = content.indexOf(HR);
  if (firstHr === -1) {
    throw new Error(
      "[whitepaper-slicer] Could not locate the first `---` HR rule (expected just after the title block).",
    );
  }
  const afterFirstHr = firstHr + HR.length;
  const secondHr = content.indexOf(HR, afterFirstHr);
  if (secondHr === -1) {
    throw new Error(
      "[whitepaper-slicer] Could not locate the second `---` HR rule (expected just after the abstract paragraph).",
    );
  }
  const abstract = content.slice(afterFirstHr, secondHr).trim();

  // ---- Sections: from each top-level heading to the next ----
  const headingRegex = /^## (\d+\. .+|Appendix [A-C] — .+)$/gm;
  const matches = [...content.matchAll(headingRegex)];

  if (matches.length !== expectedSlugs.length) {
    throw new Error(
      `[whitepaper-slicer] Expected ${expectedSlugs.length} top-level section headings, found ${matches.length}.\n` +
        `  Heading format must be "## N. Title" for sections or "## Appendix X — Title" for appendices.\n` +
        `  Slugs in sections.ts (in order): ${expectedSlugs.join(", ")}.\n` +
        `  Headings found: ${matches.map((m) => m[0]).join(" | ")}`,
    );
  }

  const sections: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i];
    const start = heading.index! + heading[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    let chunk = content.slice(start, end);
    chunk = chunk.replace(/^\s*\n/, "").trimEnd() + "\n";
    sections[expectedSlugs[i]] = chunk;
  }

  return { abstract, sections };
}

/**
 * Resolve a stable build identifier baked into the client bundle and
 * published at /version.json. Priority:
 *   1. VERCEL_GIT_COMMIT_SHA (injected by Vercel at build) — 7-char short
 *   2. local `git rev-parse --short HEAD` (local prod builds)
 *   3. Date.now() (detached / CI edge cases with no git)
 * Using the commit SHA means a redeploy of the same commit yields the same
 * id, so the version checker never false-positives on a rebuild.
 */
function resolveBuildId(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha && sha.length > 0) return sha.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return String(Date.now());
  }
}

/**
 * opta-version-emitter — writes dist/version.json at build time so the
 * deployed app can poll it and compare against its baked __BUILD_ID__.
 * Build-only: the dev server never serves it, so useVersionCheck simply
 * fails silent in dev.
 */
function versionEmitter(buildId: string): Plugin {
  return {
    name: "opta-version-emitter",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ buildId }),
      });
    },
  };
}

const BUILD_ID = resolveBuildId();

export default defineConfig({
  plugins: [whitepaperSlicer(), versionEmitter(BUILD_ID), react(), tailwindcss()],
  define: {
    global: "globalThis",
    "process.env": "{}",
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      buffer: "buffer",
      process: "process/browser",
      stream: "stream-browserify",
      util: "util",
    },
  },
  /**
   * DEV-ONLY proxy for the EPOCH 0 points API.
   *
   * The indexer's listener is LOOPBACK-ONLY and serves no CORS headers — nginx
   * adds those in production. A dev page on :5173 fetching :8791 is therefore a
   * cross-origin request the browser blocks, even though curl succeeds. Proxying
   * makes the dev fetch same-origin, matching how it will behave in production
   * behind nginx.
   *
   * Set OPTA_POINTS_PROXY to the tunnelled listener and
   * VITE_POINTS_API_BASE=/api/points:
   *   ssh -N -L 8791:127.0.0.1:8791 <VPS_USER>@<VPS_IP>
   *
   * `server` applies to `vite dev` only; the production build is unaffected.
   */
  server: {
    proxy: {
      "/api/points": {
        target: process.env.OPTA_POINTS_PROXY || "http://127.0.0.1:8791",
        changeOrigin: true,
      },
    },
  },
});
