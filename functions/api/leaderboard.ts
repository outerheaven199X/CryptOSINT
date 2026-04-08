/**
 * Cloudflare Pages Function: GET /api/leaderboard?type=SNIPER&limit=50
 * Aggregates wallet classifications from KV indexes.
 * Cached for 5 minutes per type.
 */

import type {
  WalletType,
  WalletRecord,
  LeaderboardEntry,
  LeaderboardResult,
} from "../../src/lib/types";

interface Env {
  HELIUS_API_KEY: string;
  SKNWLKR_CACHE: KVNamespace;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const VALID_TYPES = new Set<string>(["SNIPER", "INSIDER", "AGENT", "COPY"]);
const INDEX_PREFIX = "index:wallets:";
const WALLET_KV_PREFIX = "wallet:";
const CACHE_PREFIX = "leaderboard:";
const CACHE_TTL_SECONDS = 5 * 60;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const FETCH_BATCH_SIZE = 20;
const DATA_SPAN_LABEL = "last 30 days";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const url = new URL(context.request.url);
    const typeParam = url.searchParams.get("type")?.toUpperCase() ?? "SNIPER";
    const limitParam = Math.min(
      parseInt(url.searchParams.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    if (!VALID_TYPES.has(typeParam)) {
      return jsonError(`Invalid type. Use: ${[...VALID_TYPES].join(", ")}`, 400);
    }

    const walletType = typeParam as WalletType;
    const kv = context.env.SKNWLKR_CACHE;

    // Check cache
    const cacheKey = `${CACHE_PREFIX}${walletType}`;
    const cached = await kv.get(cacheKey, "json") as LeaderboardResult | null;
    if (cached) {
      const sliced = {
        ...cached,
        entries: cached.entries.slice(0, limitParam),
      };
      return jsonOk(sliced);
    }

    // Read type index
    const indexKey = `${INDEX_PREFIX}${walletType}`;
    const addresses = ((await kv.get(indexKey, "json")) as string[] | null) ?? [];

    if (addresses.length === 0) {
      const empty: LeaderboardResult = {
        type: walletType,
        entries: [],
        totalWalletsTracked: 0,
        dataSpan: DATA_SPAN_LABEL,
      };
      return jsonOk(empty);
    }

    // Fetch records for each address in batches
    const entries = await buildEntries(addresses, walletType, kv);

    // Sort by appearances descending
    entries.sort((a, b) => b.appearances - a.appearances);

    const result: LeaderboardResult = {
      type: walletType,
      entries: entries.slice(0, MAX_LIMIT),
      totalWalletsTracked: entries.length,
      dataSpan: DATA_SPAN_LABEL,
    };

    // Cache in background
    context.waitUntil(
      kv.put(cacheKey, JSON.stringify(result), {
        expirationTtl: CACHE_TTL_SECONDS,
      }),
    );

    const sliced = {
      ...result,
      entries: result.entries.slice(0, limitParam),
    };
    return jsonOk(sliced);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("Leaderboard error:", msg);
    return jsonError(msg, 500);
  }
};

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

// ── Helpers ──

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: CORS_HEADERS,
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: CORS_HEADERS },
  );
}

async function buildEntries(
  addresses: string[],
  targetType: WalletType,
  kv: KVNamespace,
): Promise<LeaderboardEntry[]> {
  const entries: LeaderboardEntry[] = [];

  for (let i = 0; i < addresses.length; i += FETCH_BATCH_SIZE) {
    const batch = addresses.slice(i, i + FETCH_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((addr) => kv.get(`${WALLET_KV_PREFIX}${addr}`, "json")),
    );

    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      if (outcome.status !== "fulfilled" || !outcome.value) continue;

      const records = outcome.value as WalletRecord[];
      const entry = aggregateRecords(
        batch[j],
        records,
        targetType,
      );
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

function aggregateRecords(
  address: string,
  records: WalletRecord[],
  targetType: WalletType,
): LeaderboardEntry | null {
  const matching = records.filter((r) => r.classification === targetType);
  if (matching.length === 0) return null;

  const totalBlocks = matching.reduce((s, r) => s + r.entryBlock, 0);
  const avgBlock = Math.round(totalBlocks / matching.length);

  // Sort by timestamp to find last seen
  const sorted = [...matching].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const lastSeen = sorted[0].timestamp;

  // Win rate: approximate from entry block (low block = likely profitable)
  // Without actual PNL data in WalletRecord, we estimate from entry timing
  const earlyEntries = matching.filter((r) => r.entryBlock <= 3).length;
  const winRate = matching.length > 0
    ? Math.round((earlyEntries / matching.length) * 100)
    : 0;

  return {
    address,
    appearances: matching.length,
    winRate,
    avgEntryBlock: avgBlock,
    totalEstimatedPnlSol: 0, // requires cross-referencing token price data
    lastSeen,
  };
}
