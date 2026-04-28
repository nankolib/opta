// =============================================================================
// tests/_write_fixtures.ts — CLI entry point: write all P2 Pyth fixtures
// =============================================================================
// Run via: npx ts-node tests/_write_fixtures.ts
// Writes /tmp/pyth_<name>.json for each fixture in ALL_FIXTURES, then
// prints the --account arguments the launcher passes to solana-test-validator.
// =============================================================================

// tsconfig.json restricts types to mocha+chai, so Node globals like
// `console`/`require` aren't visible at compile time. Ambient-declare the
// slice we need; runtime (Node 18+) provides the real implementation.
declare const console: { log: (...args: any[]) => void };
declare const require: any;

import { writeAllFixtures } from "./_pyth_fixtures";

const { launcherArgs } = writeAllFixtures("/tmp");
// Write the args to a file (avoids shell-quoting hazards with $() capture
// when args contain dashes) AND print them. The launcher reads the file.
const fs = require("fs");
fs.writeFileSync("/tmp/pyth_launcher_args.txt", launcherArgs.join(" "));
console.log(launcherArgs.join(" "));
