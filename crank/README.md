# opta-crank

Settle automation crank for the Opta options protocol on Solana. Periodically
scans for expired vault tuples and posts the on-chain settlement: fetches a
fresh Pyth Pull price update from Hermes, calls `settle_expiry` to create
the canonical SettlementRecord, then fires batched `settle_vault` calls to
flip every affected vault's `is_settled` flag.

This is the **automated replacement for the manual UI settle button**
(`AdminTools.tsx` in the frontend). Run a single instance against devnet
or mainnet; users continue to be able to settle manually via the UI without
conflict (idempotency on the on-chain side prevents double-settlement).

## Prerequisites

- Node.js 18+ (Node 20 recommended)
- A Solana keypair with SOL for tx fees (~0.005 SOL/day at demo scale)
- An RPC endpoint — Helius free tier is sufficient
- Repo built once: the crank cross-imports compiled types from `app/src/`

The crank wallet does NOT need to be the protocol admin. `settle_expiry`
and `settle_vault` are both permissionless on-chain.

## Installation

```bash
cd crank/
npm install
```

This pulls the Solana stack (~80 MB) including a pinned
`@pythnetwork/pyth-solana-receiver@0.14.0` and a single deduped
`rpc-websockets@9.3.7` (override forced — see `package.json`).

## Configuration

### Required

| Var | Purpose |
|---|---|
| `OPTA_RPC_URL` | Solana JSON-RPC endpoint. Helius devnet works: `https://devnet.helius-rpc.com/?api-key=...`. Public devnet (rate-limited) is not viable for sustained operation. |

The crank fails fast at boot if `OPTA_RPC_URL` is unset.

### Optional

| Var | Default | Purpose |
|---|---|---|
| `OPTA_CRANK_KEYPAIR` | `~/.config/solana/id.json` | Path to a Solana keypair JSON file (64-byte secret-key array). |
| `OPTA_CRANK_TICK_MS` | `300000` (5 min) | Milliseconds between tick starts. Floor: 1000ms. |
| `OPTA_HERMES_BASE` | `https://hermes.pyth.network` | Pyth Hermes endpoint. Override to `https://hermes-beta.pyth.network` for Beta-cluster testing. |
| `OPTA_AUTO_FINALIZE_HOLDER_BATCH` | `20` | Holders per `auto_finalize_holders` transaction. Each holder occupies 2 remaining-account slots and ~50K CU. The default leaves headroom under the 1.4M-CU/64-account-per-tx ceiling. Tune up if your RPC handles tightly-packed txs reliably; tune down if you see CU-exceeded failures. |
| `OPTA_AUTO_FINALIZE_WRITER_BATCH` | `20` | Writers per `auto_finalize_writers` transaction. Each writer is a triple of (writer_position, writer_usdc_ata, writer_wallet) — 3 remaining-account slots, ~30-80K CU each. Same tuning rules as the holder batch. |
| `OPTA_AUTO_CANCEL_BATCH_SIZE` | `8` | Listings per `auto_cancel_listings` transaction. Each listing occupies 4 remaining-account slots and ~65K CU (Step 5 smoke measurement). The default leaves headroom under the 800K-CU budget for this pass. Tune up if you see consistent under-budget completion; tune down if you see CU-exceeded failures. |
| `OPTA_AUTO_FINALIZE_MAX_ATAS_PER_TICK` | `100` | Per-tick cap on idempotent USDC-ATA creates by the crank wallet. Each ATA create costs ~0.002 SOL of rent paid by the crank wallet, so the default caps tick exposure at ~0.2 SOL. The budget is shared across the holder + writer passes (per-tick total, not per-pass). When exhausted, this tick processes whatever it can and the next tick picks up the rest. |
| `OPTA_AUTO_FINALIZE_STALE_S` | `3600` (1 hour) | Threshold for "vault has been settled too long without being finalized." Each tick emits a `warn` log line for any vault whose expiry was more than this many seconds ago and is still not fully finalized. Real failures (constraint mismatches, IDL drift) won't self-heal; surfacing them helps the operator notice. |
| `OPTA_AUTO_FINALIZE_DRY_RUN` | unset (false) | When set to `true`, `1`, or `yes`, the auto-finalize **and auto-cancel** passes enumerate everything (holders, writers, listings, missing ATAs) and emit normal log lines but send NO transactions. Designed as the operator's safety net for a first-time deploy and as a debugging tool for verifying the gpa filter shapes against real on-chain state without spending SOL. |

### Endpoint selection

The crank defaults to **mainnet Hermes** (`hermes.pyth.network`). Mainnet
Hermes serves price updates signed by Pyth's production Wormhole guardian
set, which Solana devnet's Wormhole Core Bridge tracks. The Beta cluster
(`hermes-beta.pyth.network`) signs with a separate guardian set that
Solana devnet does not currently track — settle attempts via Beta will
fail with `GuardianSetExpired` from Wormhole's `VerifyEncodedVaaV1`.

Mainnet Hermes serves the same feed_ids on devnet and mainnet (the on-
chain Pyth Receiver is the same program ID across clusters). Use Beta
only if you have specific feed_ids that exist on Beta but not mainnet,
and only against a Solana cluster whose Wormhole tracks Beta guardians.

## Running the crank

### Local development / smoke

```bash
cd crank/
OPTA_RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_KEY" \
  npm start
```

Or with all options:

```bash
OPTA_RPC_URL="..." \
OPTA_CRANK_KEYPAIR="/path/to/hot-wallet.json" \
OPTA_CRANK_TICK_MS=60000 \
  npm start
```

Stop with Ctrl+C. The crank finishes the current tick before exiting (it
won't kill an in-flight RPC).

### Production / persistent server

The crank has **no auto-restart**. If the process dies (network outage,
out-of-memory, unhandled exception escaping the per-tick try/catch), it
stays dead until manually restarted. This is intentional — a misconfigured
crank looping forever on a fatal config issue is worse than one that
exits and surfaces the error.

For uptime, run under a process supervisor:

```ini
# systemd unit (sketch — ts-node mode)
[Service]
Environment="OPTA_RPC_URL=..."
Environment="OPTA_CRANK_KEYPAIR=/etc/opta/hot-wallet.json"
ExecStart=/usr/bin/node --require ts-node/register --require tsconfig-paths/register /opt/opta/crank/bot.ts
Restart=on-failure
RestartSec=30
```

**Precompile alternative.** Operators who prefer not to ship `ts-node` +
`tsconfig-paths` register hooks in production can run `npm run typecheck`
followed by `tsc` (which emits to `dist/`) once at deploy time and have
systemd run plain `node /opt/opta/crank/dist/bot.js`. Either approach is
valid; ts-node is more convenient for iteration, precompiled JS is more
conventional for long-running prod processes.

Or `pm2`, or a Docker container with `restart: unless-stopped`. The crank
itself stays one-shot per instance.

## What the crank does (per tick)

1. Fetch all `sharedVault` and `optionsMarket` accounts from the program
   (2 RPC calls, parallel).
2. Group expired non-settled vaults by `(asset, expiry)`. A vault counts
   as expired when `vault.expiry < now()` and `!vault.is_settled`.
3. For each tuple, call `settleAllForExpiry`:
   - Fetch a fresh Pyth update from Hermes-Beta (binary VAA, ~700 bytes).
   - Submit one atomic transaction: `post_update_atomic` +
     `settle_expiry` + close. This creates the canonical SettlementRecord.
   - Fire `settle_vault` instructions in chunks of 5 per tx until every
     vault in the tuple has `is_settled = true`.
4. If the SettlementRecord already exists (a previous crank run posted it,
   or the UI did), Phase 1 is skipped and only the remaining
   `settle_vault` calls fire — the resume path.
5. **Phase 2a — auto-cancel pass.** Per settled vault: enumerate every
   `VaultResaleListing` belonging to that vault. For each, return the
   escrowed option tokens to the seller's regular Token-2022 ATA (signed
   by `protocol_state` PDA — the transfer hook permits even post-expiry
   because source is protocol-owned), close the escrow Token-2022 account
   (rent → seller wallet), and close the listing PDA via manual lamport
   drain. Runs **before** the holder finalize pass so the returned tokens
   become regular holder candidates for that pass to burn + pay out.
   Listings whose seller closed their Token-2022 ATA are skipped + logged
   as `warn`; sellers can recover those tokens by manually calling
   `cancel_v2_resale` from their wallet.
6. Log per-tuple success or failure as a single JSON line.

A tick with zero expired tuples logs nothing. The crank stays silent
during quiet periods.

## Logs

One JSON-per-line event to stdout (info/warn) or stderr (error/fatal).
Schema:

```json
{"ts": "ISO8601", "level": "info|warn|error|fatal", "msg": "...", ...fields}
```

The `bigint: Failed to load bindings, pure JS will be used` startup line
is a pre-existing transitive-dep notice from the Solana stack — pure-JS
fallback works correctly, no action needed.

Example sequence during a productive tick:

```json
{"ts":"...","level":"info","msg":"crank started","wallet":"5YRM…","rpc":"https://devnet.helius-rpc.com/?api-key=<redacted>","intervalMs":300000,"programId":"CtzJ…"}
{"ts":"...","level":"info","msg":"tuples to process","count":2}
{"ts":"...","level":"info","msg":"tuple settled","asset":"SOL","expiry":1730284800,"vaultsFinalized":3,"atomicSig":"5qMt…","vaultBatchTxs":1,"resumed":false}
{"ts":"...","level":"error","msg":"tuple failed (will retry next tick)","asset":"BTC","expiry":1730284800,"err":"PriceTooOld"}
{"ts":"...","level":"info","msg":"tick complete","tuplesFound":2,"tuplesProcessed":1,"errors":1,"durationMs":12483}
```

Pipe to a file: `npm start | tee -a crank.log`. Filter errors:
`grep '"level":"error"' crank.log`. Pull a single tuple's history:
`grep '"asset":"SOL"' crank.log`.

The Helius API key in the RPC URL is automatically redacted in the
`crank started` log line.

## Failure modes & recovery

| Failure | Behavior | Recovery |
|---|---|---|
| `OPTA_RPC_URL` unset | Fail-fast at boot, exit 1 | Set the env var and restart |
| Keypair file missing or malformed | Fail-fast at boot, exit 1 | Fix the path / file |
| Hermes unreachable mid-tick | Per-tuple error logged, tick continues | Next tick retries automatically |
| RPC rate-limited or down | Tick fails entirely, error logged | Next tick retries; if persistent, switch to a more generous RPC endpoint |
| Tx fails with `PriceTooOld` | Tuple-level error, tick continues | Next tick fetches a fresh Hermes update |
| Tx fails with `VaultAlreadySettled` (race with UI) | Tuple-level error, tick continues | No action — the vault was settled by another caller |
| Tx confirmation timeout | Tuple-level error | Next tick re-reads chain state and resumes from wherever it left off (idempotent retries) |
| Process killed mid-tick | Crank exits | Restart manually; idempotency guarantees no double-settlement |
| Listing's seller option ATA missing | Per-listing `warn` logged, listing skipped in batch | Seller manually calls `cancel_v2_resale` from their wallet to recover the tokens; the crank does not pre-create user state |

All on-chain instructions called by the crank (`settle_expiry`,
`settle_vault`) are naturally idempotent — they reject re-execution against
already-settled state. **The crank can crash and restart with no risk of
double-settlement, double-spend, or corrupted state.**

If two crank instances run simultaneously, both will scan the same tuples
and race on each settle. The first one wins; the second's transactions
fail with already-settled errors and are logged as tuple failures. **Funds
are safe but ~0.005 SOL/duplicate-tx is wasted.** Avoid running multiple
instances; the system tolerates it but doesn't benefit.

## Production hot-wallet recommendation

For local hackathon / demo: the default `~/.config/solana/id.json` keypair
(typically the protocol admin / deploy keypair) is fine. The crank doesn't
require admin privileges; it just spends SOL.

**For production: use a dedicated hot wallet** with a small SOL balance
(refilled periodically). Set `OPTA_CRANK_KEYPAIR` to its path. Reasons:

1. The crank wallet is online 24/7. A compromise leaks only the SOL in
   that wallet, not the protocol admin authority.
2. Scoped permissions: the hot wallet has no on-chain authority over
   anything beyond paying fees.
3. Easier to rotate: replace the keypair file, restart the crank.

A typical refill cadence: top up to 0.5 SOL whenever the balance drops
below 0.1 SOL. At demo scale (~0.005 SOL/day), one top-up lasts months.

## Stopping the crank

- **SIGINT** (Ctrl+C): graceful. Crank finishes the in-flight tick — or
  the in-flight per-tuple settle, if a tick is mid-loop — then exits.
- **SIGTERM**: same as SIGINT.
- **SIGKILL** (`kill -9`): immediate. Any in-flight RPC is dropped; the
  on-chain side may still commit if the tx already went out. Idempotency
  protects against double-execution on next restart.

Hammering Ctrl+C twice doesn't speed anything up — the second signal is
ignored; the first is the one that triggers the shutdown flag.

## Architecture quick reference

- **Single file**: `bot.ts`. ~210 lines. Bootstrap, log, loop, tick,
  signal handling.
- **Cross-imports** (via tsconfig path alias `@app/*`): three helpers
  from `app/src/`:
  - `pythPullPost.settleAllForExpiry` — composes the atomic settle
    transaction + per-vault batches.
  - `useFetchAccounts.safeFetchAll` — typed account scanner with
    discriminator-based memcmp.
  - `format.hexFromBytes` — feed_id byte-array → hex string.
- **Three top-level finalize entry points** (per-vault, called in order
  inside the bot's tick loop for each settled vault):
  - `runAutoCancelListings` (`autoCancelListings.ts`) — drains open
    listings on settled vaults; runs first so returned tokens become
    holder candidates.
  - `runHolderFinalize` (`autoFinalize.ts`) — burns holder tokens, pays
    ITM payouts.
  - `runWriterFinalize` (`autoFinalize.ts`) — pays writer collateral +
    premium, closes vault USDC on the last writer.
- **No daemon, no auto-restart**: see "Production / persistent server".
- **No state on disk**: every tick re-reads chain state. Crash-restart
  safe.

For deeper architecture context, see `MIGRATION_LOG.md` (the
"Stage P4d" and "Stage P5" sections describe the on-chain side that this
crank automates).
