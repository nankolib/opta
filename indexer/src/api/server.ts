// =============================================================================
// server.ts — in-process HTTP listener, LOOPBACK ONLY
// =============================================================================
//
// Binds 127.0.0.1 by default and is never exposed directly. Public access is
// nginx's job, and that conf ships STAGED (deploy/nginx/points-api.conf.staged)
// rather than applied — see indexer/GO-LIVE.md in the private opta-ops repo. Nothing about this listener is reachable
// from the internet until that step is taken deliberately.
//
// In-process by design: no second service, no second RPC client, no second copy
// of the DB handle, and no extra resident memory beyond the request buffers.
// =============================================================================

import * as http from "node:http";

import type { Config } from "../env";
import type { DB } from "../db";
import { log } from "../log";
import {
  getLeaderboard,
  getQuests,
  getRules,
  getStats,
  getWallet,
  postBountySubmit,
  postReferralBind,
  postReferralCode,
  postSocialSubmit,
  type ApiDeps,
  type ApiResponse,
  getListingRequested,
  postListingRequest,
} from "./handlers";

import {
  getChainEpochs, getChainMarkets, getChainMeta, getChainSeries, getChainVaults,
} from "../chain/handlers";

const MAX_BODY_BYTES = 4096;

/**
 * Origins allowed to read the chain endpoints from a browser.
 *
 * The data is public on chain, so this is not a confidentiality boundary — it
 * keeps the surface named and reviewable rather than opening `*` and forgetting
 * about it. Node probes have no origin and are unaffected, which is exactly why
 * a cross-origin claim has to be checked in a real browser and not with curl.
 */
const CHAIN_CORS_ORIGINS = new Set([
  "https://opta.fyi",
  "https://www.opta.fyi",
  "http://localhost:5173",
  "http://localhost:4173",
]);

/**
 * CORS IS NGINX'S JOB, NOT OURS.
 *
 * This returned an Access-Control-Allow-Origin header, and so does the nginx
 * location block in front of it. A response carrying the header TWICE is
 * rejected outright by every browser — and curl does not care, so the mistake
 * survives every command-line check and only appears in a real browser.
 *
 * The indexer listens on loopback, so nginx is the only route to it; one layer
 * owns the header, and it is the one that is always in the path. The origin
 * allowlist above stays as documentation of the intended surface.
 */
function corsHeadersFor(_origin: string | undefined): Record<string, string> {
  return {};
}

/**
 * Chain reads are cacheable; the points endpoints are not, which is why they do
 * not share `send`. `max-age` is deliberately BELOW the refresh cadence so an
 * intermediary can absorb a burst without ever serving data older than the
 * server's own staleness threshold — the response carries its slot regardless,
 * so a client can always tell.
 */
function sendChain(res: http.ServerResponse, r: ApiResponse, origin: string | undefined): void {
  const payload = JSON.stringify(r.body);
  res.writeHead(r.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=10",
    "content-length": Buffer.byteLength(payload),
    ...corsHeadersFor(origin),
  });
  res.end(payload);
}

function send(res: http.ServerResponse, r: ApiResponse): void {
  const payload = JSON.stringify(r.body);
  res.writeHead(r.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const ctype = String(req.headers["content-type"] ?? "");
  if (!ctype.toLowerCase().includes("application/json")) {
    return { ok: false, status: 415, error: "expected_application_json" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) return { ok: false, status: 413, error: "body_too_large" };
    chunks.push(c as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

export function createApiServer(db: DB, cfg: Config): http.Server {
  const deps: ApiDeps = {
    db,
    x: { bearer: cfg.xBearer, mentionHandle: cfg.xMention, maxAgeSecs: cfg.xMaxAgeSecs },
    cooldownSecs: cfg.writeCooldownSecs,
    socialPointsPerPost: cfg.socialPointsPerPost,
    socialMaxPerDay: cfg.socialMaxPerDay,
    now: () => Math.floor(Date.now() / 1000),
  };

  return http.createServer(async (req, res) => {
    const started = Date.now();
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return send(res, { status: 400, body: { error: "bad_url" } });
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (req.method === "OPTIONS") {
        // Preflight for the chain reads. Points endpoints are same-origin and
        // unaffected by the extra headers.
        // Preflight is answered by nginx (it returns 204 before proxying), so
        // this only serves direct loopback callers. No CORS headers here: see
        // corsHeadersFor.
        res.writeHead(204).end();
        return;
      }

      // ---- reads --------------------------------------------------------
      if (req.method === "GET") {
        // ---- chain read path (v8) ---------------------------------------
        // READ-ONLY. Structural account state only — never the book, positions
        // or balances. Every response carries the slot it was built at.
        if (path.startsWith("/api/chain/")) {
          const origin = req.headers.origin;
          const q = url.searchParams;
          if (path === "/api/chain/vaults")  return sendChain(res, getChainVaults(db, q), origin);
          if (path === "/api/chain/series")  return sendChain(res, getChainSeries(db, q), origin);
          if (path === "/api/chain/markets") return sendChain(res, getChainMarkets(db, q), origin);
          if (path === "/api/chain/epochs")  return sendChain(res, getChainEpochs(db, q), origin);
          if (path === "/api/chain/meta") {
            return sendChain(res, getChainMeta(db, {
              programId: cfg.programId,
              deploySlot: cfg.chainDeploySlot ?? null,
            }), origin);
          }
          return sendChain(res, { status: 404, body: { error: "not_found" } }, origin);
        }

        if (path === "/api/points/leaderboard") {
          return send(res, getLeaderboard(db, url.searchParams.get("board") ?? "profit", Number(url.searchParams.get("limit") ?? 50)));
        }
        if (path === "/api/points/quests") return send(res, getQuests(db));
        if (path === "/api/points/rules") return send(res, getRules(db));
        if (path === "/api/points/stats") return send(res, getStats(db));
        // SLICE 2C — has this wallet already requested this mint? Unauth by
        // design: it discloses only a pair the caller already supplied.
        if (path === "/api/points/listing/requested") {
          return send(res, getListingRequested(db, url.searchParams.get("wallet") ?? "", url.searchParams.get("mint") ?? ""));
        }
        if (path.startsWith("/api/points/wallet/")) {
          return send(res, getWallet(db, decodeURIComponent(path.slice("/api/points/wallet/".length))));
        }
        return send(res, { status: 404, body: { error: "not_found" } });
      }

      // ---- writes -------------------------------------------------------
      if (req.method === "POST") {
        const routes: Record<string, ((env: never) => ApiResponse | Promise<ApiResponse>) | undefined> = {
          "/api/points/referral/code": (env) => postReferralCode(deps, env),
          "/api/points/referral/bind": (env) => postReferralBind(deps, env),
          "/api/points/social/submit": (env) => postSocialSubmit(deps, env),
          "/api/points/bounty/submit": (env) => postBountySubmit(deps, env),
          "/api/points/listing/request": (env) => postListingRequest(deps, env),
        };
        const handler = routes[path];
        if (!handler) return send(res, { status: 404, body: { error: "not_found" } });

        const body = await readJsonBody(req);
        if (!body.ok) return send(res, { status: body.status, body: { error: body.error } });
        return send(res, await handler(body.value as never));
      }

      return send(res, { status: 405, body: { error: "method_not_allowed" } });
    } catch (e) {
      // Never leak an internal message to the caller.
      log.error("api handler threw", { path, err: (e as Error).message });
      return send(res, { status: 500, body: { error: "internal" } });
    } finally {
      log.info("api", { method: req.method, path, ms: Date.now() - started });
    }
  });
}

export function startApiServer(db: DB, cfg: Config): http.Server | null {
  if (!cfg.apiEnabled) {
    log.info("api disabled", {});
    return null;
  }
  const server = createApiServer(db, cfg);
  server.listen(cfg.apiPort, cfg.apiHost, () => {
    log.info("api listening", { host: cfg.apiHost, port: cfg.apiPort, note: "loopback only; nginx conf is STAGED, not applied" });
  });
  server.on("error", (e) => log.error("api server error", { err: (e as Error).message }));
  return server;
}
