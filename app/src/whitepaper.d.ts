/**
 * Virtual module produced by the `opta-whitepaper-slicer` Vite plugin
 * (see vite.config.ts). Importing any `.md` file with the `?slice`
 * query returns a build-time-sliced object containing the whitepaper's
 * abstract paragraph plus a slug-keyed map of section bodies.
 *
 * Slugs match the entries in app/src/pages/docs/sections.ts; the
 * plugin asserts the count and fails the build on drift.
 */
declare module "*.md?slice" {
  const doc: {
    /** Prose between the first two `---` HR rules (the abstract). */
    abstract: string;
    /** Section body content keyed by slug, heading line stripped. */
    sections: Record<string, string>;
  };
  export default doc;
}
