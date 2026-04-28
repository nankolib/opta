// =============================================================================
// tests/_write_fixtures.ts — CLI entry point: write all P2 Pyth fixtures
// =============================================================================
// Run via: npx ts-node tests/_write_fixtures.ts [outDir]
// Writes <outDir>/pyth_<name>.json for each fixture in ALL_FIXTURES, then
// prints the --account arguments the launcher passes to solana-test-validator.
//
// outDir defaults to OPTA_FIXTURE_DIR env var, then "/tmp". Use a non-/tmp
// path on systems that auto-clear /tmp between shell sessions (e.g. WSL2).
// =============================================================================

// tsconfig.json restricts types to mocha+chai, so Node globals like
// `console`/`require`/`module`/`process` aren't visible at compile time.
// Ambient-declare the slice we need; runtime (Node 18+) provides the real
// implementation.
declare const console: { log: (...args: any[]) => void };
declare const require: any;
declare const module: any;
declare const process: { argv: string[]; env: Record<string, string | undefined> };

import { writeAllFixtures } from "./_pyth_fixtures";

// CLI guard: ts-mocha globs `tests/**/*.ts` and *imports* this file before
// running any test. Without this guard the CLI body would execute on every
// test run and try to write fixtures into whatever path happens to sit at
// process.argv[2] (which mocha sets to "--require"). Only run when invoked
// directly as `npx ts-node tests/_write_fixtures.ts [outDir]`.
if (require.main === module) {
  const outDir = process.argv[2] ?? process.env.OPTA_FIXTURE_DIR ?? "/tmp";
  const { launcherArgs } = writeAllFixtures(outDir);
  // Write the args to a file (avoids shell-quoting hazards with $() capture
  // when args contain dashes) AND print them. The launcher reads the file.
  const fs = require("fs");
  fs.writeFileSync(outDir + "/pyth_launcher_args.txt", launcherArgs.join(" "));
  console.log(launcherArgs.join(" "));
}
