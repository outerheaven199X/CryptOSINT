/**
 * Cloudflare Pages Function: GET /api/threats
 * Monitors recently scanned tokens for LP removal events.
 *
 * Strategy:
 * 1. Read recently scanned token mints from KV (stored by scan.ts)
 * 2. For each, fetch latest transactions via Helius
 * 3. Run LP removal + coordinated dump detection
 * 4. Return ThreatEvent[] sorted newest-first
 *
 * Cached for 60s to avoid hammering Helius on every frontend poll.
 */

import { getTransactionsForToken, getTokenMetadata } from "../../src/lib/helius";
import { detectLpRemovals, detectCoordinatedDumps } from "../../src/lib/threats";
import type { ThreatEvent } from "../../src/lib/types";

interface Env {
  HELIUS_API_KEY: string;
  SKNWLKR_CACHE: KVNamespace;
}

const RECENT_TOKENS_KEY = "threats:recent_tokens";
const THREATS_CACHE_KEY = "threats:cached";
const CACHE_TTL_SECONDS = 60;
const MAX_TOKENS_TO_MONITOR = 10;
const TX_FETCH_LIMIT = 100;

/** Token entry stored in KV by the scan endpoint. */
interface MonitoredToken {
  mint: string;
  symbol: string;
  scannedAt: string;
  insiderAddresses: string[];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const apiKey = context.env.HELIUS_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured: missing API key" }),
        { status: 500, headers: corsHeaders },
      );
    }

    const kv = context.env.SKNWLKR_CACHE;

    // Check threat cache first
    const cached = await kv.get(THREATS_CACHE_KEY, "json") as ThreatEvent[] | null;
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // Load recently scanned tokens
    const tokens = await loadRecentTokens(kv);
    if (tokens.length === 0) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // Monitor each token for threats
    const allThreats: ThreatEvent[] = [];
    const settled = await Promise.allSettled(
      tokens.slice(0, MAX_TOKENS_TO_MONITOR).map((token) =>
        monitorToken(token, apiKey),
      ),
    );

    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        allThreats.push(...outcome.value);
      }
    }

    // Merge in webhook-generated alerts from KV
    const kvAlerts = await loadKvAlerts(kv);
    allThreats.push(...kvAlerts);

    // Sort newest first
    allThreats.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    // Deduplicate by id
    const seen = new Set<string>();
    const deduped = allThreats.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });

    // Cap at 20 events
    const result = deduped.slice(0, 20);

    // Cache result
    context.waitUntil(
      kv.put(THREATS_CACHE_KEY, JSON.stringify(result), {
        expirationTtl: CACHE_TTL_SECONDS,
      }),
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("Threats error:", message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: corsHeaders },
    );
  }
};

const ALERT_KV_PREFIX = "alert:";
const MAX_KV_ALERTS = 30;

/**
 * Load webhook-generated alert events from KV.
 * These are written by the /api/webhook endpoint.
 */
async function loadKvAlerts(kv: KVNamespace): Promise<ThreatEvent[]> {
  try {
    const listed = await kv.list({ prefix: ALERT_KV_PREFIX, limit: MAX_KV_ALERTS });
    if (listed.keys.length === 0) return [];

    const settled = await Promise.allSettled(
      listed.keys.map((k) => kv.get(k.name, "json")),
    );

    const alerts: ThreatEvent[] = [];
    for (const outcome of settled) {
      if (outcome.status === "fulfilled" && outcome.value) {
        alerts.push(outcome.value as ThreatEvent);
      }
    }
    return alerts;
  } catch {
    return [];
  }
}

async function loadRecentTokens(kv: KVNamespace): Promise<MonitoredToken[]> {
  const raw = await kv.get(RECENT_TOKENS_KEY, "json") as MonitoredToken[] | null;
  return raw ?? [];
}

async function monitorToken(
  token: MonitoredToken,
  apiKey: string,
): Promise<ThreatEvent[]> {
  const transactions = await getTransactionsForToken(
    token.mint,
    apiKey,
    TX_FETCH_LIMIT,
  );

  if (transactions.length === 0) return [];

  const lpThreats = detectLpRemovals(
    transactions,
    token.mint,
    token.symbol,
  );

  const insiderSet = new Set(token.insiderAddresses);
  const dumpThreats = detectCoordinatedDumps(
    transactions,
    token.mint,
    token.symbol,
    insiderSet,
  );

  return [...lpThreats, ...dumpThreats];
}

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
};
