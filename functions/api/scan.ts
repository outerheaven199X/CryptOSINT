/**
 * Cloudflare Pages Function: POST /api/scan
 * Proxies Helius API, runs classification, returns ScanResult.
 *
 * To run locally: npx wrangler pages dev dist
 * Requires HELIUS_API_KEY in .dev.vars or Cloudflare dashboard.
 */

import {
  getTransactionsForToken,
  getTokenMetadata,
  getWalletOriginBatch,
} from "../../src/lib/helius";
import type { WalletOrigin } from "../../src/lib/helius";
import {
  buildWalletProfiles,
  classifyAllWallets,
  detectCopyRelationships,
  computeOrganicScore,
  generateVerdict,
  computeReputation,
} from "../../src/lib/classify";
import type { WalletType, ScanResult, WalletRecord, ClassifiedWallet } from "../../src/lib/types";

interface Env {
  HELIUS_API_KEY: string;
  SKNWLKR_CACHE: KVNamespace;
}

const KV_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const KV_PREFIX = "wallet:";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const body = (await context.request.json()) as { mint: string };
    const mint = body.mint?.trim();

    if (!mint || mint.length < 32) {
      return new Response(
        JSON.stringify({ error: "Invalid token mint address" }),
        { status: 400, headers: corsHeaders }
      );
    }

    const apiKey = context.env.HELIUS_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured: missing API key" }),
        { status: 500, headers: corsHeaders }
      );
    }

    // 1. Get token metadata
    const metadata = await getTokenMetadata(mint, apiKey);

    // 2. Fetch full parsed transactions in one call per page
    const transactions = await getTransactionsForToken(mint, apiKey, 500);

    if (transactions.length === 0) {
      return new Response(
        JSON.stringify({ error: "No transactions found for this token" }),
        { status: 404, headers: corsHeaders }
      );
    }

    // 3. Identify deployer (first transaction's fee payer)
    const sortedTxs = [...transactions].sort((a, b) => a.slot - b.slot);
    const deployerAddress = sortedTxs[0]?.feePayer || "";

    // 4. Build wallet profiles
    const profiles = buildWalletProfiles(transactions, mint, deployerAddress);

    // 5. Estimate total supply from observed transfers
    const totalSupply = profiles.reduce(
      (sum, p) => sum + Math.max(0, p.currentHolding),
      0
    );

    // 6. Classify all wallets
    const classifiedWallets = classifyAllWallets(profiles, totalSupply);

    // 7. Compute scores
    const organicScore = computeOrganicScore(classifiedWallets);

    const counts: Record<WalletType, number> = {
      AGENT: 0,
      INSIDER: 0,
      COPY: 0,
      SNIPER: 0,
      ORGANIC: 0,
    };
    for (const w of classifiedWallets) {
      counts[w.type]++;
    }

    const verdict = generateVerdict(organicScore, counts);

    // 8. KV read: attach prior history to each wallet
    await attachPriorHistory(classifiedWallets, context.env.SKNWLKR_CACHE);

    // 8b. Wallet age & origin for flagged wallets (INSIDER, AGENT, SNIPER)
    await enrichWithOrigins(classifiedWallets, apiKey, context.env.SKNWLKR_CACHE);

    // 8c. Compute reputation scores from prior history
    attachReputationScores(classifiedWallets);

    // 8d. Detect copy trade network
    const copyNetwork = detectCopyRelationships(profiles, classifiedWallets);

    // 9. Sort wallets: insiders first, then agents, snipers, copy, organic
    const typeOrder: Record<WalletType, number> = {
      INSIDER: 0,
      AGENT: 1,
      SNIPER: 2,
      COPY: 3,
      ORGANIC: 4,
    };
    classifiedWallets.sort(
      (a, b) =>
        typeOrder[a.type] - typeOrder[b.type] ||
        a.entryBlock - b.entryBlock
    );

    // 10. Compute token age
    const firstTimestamp = sortedTxs[0]?.timestamp || 0;
    const ageSeconds = Math.floor(Date.now() / 1000) - firstTimestamp;
    const ageStr =
      ageSeconds < 3600
        ? `${Math.floor(ageSeconds / 60)}m`
        : ageSeconds < 86400
          ? `${Math.floor(ageSeconds / 3600)}h ${Math.floor((ageSeconds % 3600) / 60)}m`
          : `${Math.floor(ageSeconds / 86400)}d`;

    const result: ScanResult = {
      token: {
        name: metadata.name,
        symbol: metadata.symbol,
        mint,
        age: ageStr,
        mcap: 0,
        volume24h: 0,
        totalHolders: classifiedWallets.length,
        deployerAddress,
      },
      organicScore,
      counts,
      wallets: classifiedWallets.slice(0, 50),
      copyNetwork: copyNetwork.length > 0 ? copyNetwork : undefined,
      verdict,
    };

    const response = new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders,
    });

    // 11. KV write: store classifications without blocking response
    const insiderAddresses = classifiedWallets
      .filter((w) => w.type === "INSIDER")
      .map((w) => w.address);

    context.waitUntil(
      Promise.allSettled([
        writeClassificationsToKV(
          classifiedWallets,
          mint,
          metadata.symbol,
          context.env.SKNWLKR_CACHE,
        ),
        registerTokenForMonitoring(
          mint,
          metadata.symbol,
          insiderAddresses,
          context.env.SKNWLKR_CACHE,
        ),
        updateTypeIndexes(
          classifiedWallets,
          context.env.SKNWLKR_CACHE,
        ),
      ]),
    );

    return response;
  } catch (err: any) {
    console.error("Scan error:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: corsHeaders }
    );
  }
};

// ── KV Helpers ──

const FLAGGED_TYPES = new Set(["INSIDER", "AGENT", "SNIPER"]);
const ORIGIN_KV_PREFIX = "origin:";
const ORIGIN_TTL_SECONDS = 30 * 24 * 60 * 60;

async function enrichWithOrigins(
  wallets: ClassifiedWallet[],
  apiKey: string,
  kv: KVNamespace,
): Promise<void> {
  const flagged = wallets.filter((w) => FLAGGED_TYPES.has(w.type));
  if (flagged.length === 0) return;

  // Check KV cache first
  const uncached: ClassifiedWallet[] = [];
  const cacheResults = await Promise.allSettled(
    flagged.map((w) => kv.get(`${ORIGIN_KV_PREFIX}${w.address}`, "json")),
  );

  for (let i = 0; i < flagged.length; i++) {
    const outcome = cacheResults[i];
    if (outcome.status === "fulfilled" && outcome.value) {
      const cached = outcome.value as WalletOrigin;
      applyOriginToWallet(flagged[i], cached);
    } else {
      uncached.push(flagged[i]);
    }
  }

  if (uncached.length === 0) return;

  // Fetch origins for uncached wallets
  const origins = await getWalletOriginBatch(
    uncached.map((w) => w.address),
    apiKey,
  );

  // Apply + cache via waitUntil-safe writes
  const writes: Promise<void>[] = [];
  for (const w of uncached) {
    const origin = origins.get(w.address);
    if (!origin) continue;
    applyOriginToWallet(w, origin);
    writes.push(
      kv.put(`${ORIGIN_KV_PREFIX}${w.address}`, JSON.stringify(origin), {
        expirationTtl: ORIGIN_TTL_SECONDS,
      }),
    );
  }
  await Promise.allSettled(writes);
}

function applyOriginToWallet(w: ClassifiedWallet, origin: WalletOrigin): void {
  if (origin.firstTxTimestamp > 0) {
    w.walletAge = formatAge(origin.firstTxTimestamp);
  }
  if (origin.firstFunder) {
    w.firstFunder = origin.firstFunder;
    w.firstFundAmountSol = origin.firstFundAmount;
  }
}

function formatAge(firstTxTimestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000) - firstTxTimestamp;
  if (seconds < 0) return "0s";

  const MINUTE = 60;
  const HOUR = 3600;
  const DAY = 86400;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  if (seconds < MONTH) return `${Math.floor(seconds / DAY)}d`;
  if (seconds < YEAR) {
    const months = Math.floor(seconds / MONTH);
    return `${months}mo`;
  }
  const years = Math.floor(seconds / YEAR);
  const remainingMonths = Math.floor((seconds % YEAR) / MONTH);
  return remainingMonths > 0 ? `${years}y ${remainingMonths}mo` : `${years}y`;
}

async function attachPriorHistory(
  wallets: ClassifiedWallet[],
  kv: KVNamespace,
): Promise<void> {
  const settled = await Promise.allSettled(
    wallets.map((w) => kv.get(`${KV_PREFIX}${w.address}`, "json")),
  );

  for (let i = 0; i < wallets.length; i++) {
    const outcome = settled[i];
    if (outcome.status !== "fulfilled" || !outcome.value) continue;
    const records = outcome.value as WalletRecord[];
    if (records.length === 0) continue;
    wallets[i].priorHistory = records.map((r) => ({
      tokenSymbol: r.tokenSymbol,
      classification: r.classification,
      timestamp: r.timestamp,
    }));
  }
}

/**
 * Compute reputation scores for wallets that have prior history.
 * Must be called after attachPriorHistory and enrichWithOrigins.
 */
function attachReputationScores(wallets: ClassifiedWallet[]): void {
  for (const w of wallets) {
    if (!w.priorHistory || w.priorHistory.length === 0) continue;

    const records: WalletRecord[] = w.priorHistory.map((p) => ({
      tokenMint: "",
      tokenSymbol: p.tokenSymbol,
      classification: p.classification,
      entryBlock: w.entryBlock,
      timestamp: p.timestamp,
    }));

    w.reputation = computeReputation(records, w.walletAge);
  }
}

async function writeClassificationsToKV(
  wallets: ClassifiedWallet[],
  tokenMint: string,
  tokenSymbol: string,
  kv: KVNamespace,
): Promise<void> {
  const now = new Date().toISOString();
  const writes = wallets.map(async (w) => {
    const key = `${KV_PREFIX}${w.address}`;
    const existing = ((await kv.get(key, "json")) as WalletRecord[] | null) ?? [];
    const alreadyRecorded = existing.some((r) => r.tokenMint === tokenMint);
    if (alreadyRecorded) return;

    const record: WalletRecord = {
      tokenMint,
      tokenSymbol,
      classification: w.type,
      entryBlock: w.entryBlock,
      timestamp: now,
    };
    const updated = [...existing, record].slice(-50); // cap at 50 records per wallet
    await kv.put(key, JSON.stringify(updated), { expirationTtl: KV_TTL_SECONDS });
  });

  await Promise.allSettled(writes);
}

// ── Threat monitoring registration ──

const RECENT_TOKENS_KEY = "threats:recent_tokens";
const MAX_MONITORED_TOKENS = 20;
const MONITORED_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days

interface MonitoredToken {
  mint: string;
  symbol: string;
  scannedAt: string;
  insiderAddresses: string[];
}

/**
 * Register a scanned token for LP threat monitoring.
 * Keeps a rolling list of recently scanned tokens in KV.
 */
async function registerTokenForMonitoring(
  mint: string,
  symbol: string,
  insiderAddresses: string[],
  kv: KVNamespace,
): Promise<void> {
  const existing = ((await kv.get(RECENT_TOKENS_KEY, "json")) as MonitoredToken[] | null) ?? [];

  // Remove duplicate if already present
  const filtered = existing.filter((t) => t.mint !== mint);

  const entry: MonitoredToken = {
    mint,
    symbol,
    scannedAt: new Date().toISOString(),
    insiderAddresses,
  };

  // Prepend new token, cap list
  const updated = [entry, ...filtered].slice(0, MAX_MONITORED_TOKENS);
  await kv.put(RECENT_TOKENS_KEY, JSON.stringify(updated), {
    expirationTtl: MONITORED_TOKEN_TTL,
  });
}

// ── Leaderboard type indexes ──

const INDEX_PREFIX = "index:wallets:";
const INDEX_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_INDEX_SIZE = 500;

/**
 * Maintain per-type address indexes for the leaderboard.
 * Each key `index:wallets:{TYPE}` holds a JSON array of addresses.
 */
async function updateTypeIndexes(
  wallets: ClassifiedWallet[],
  kv: KVNamespace,
): Promise<void> {
  // Group addresses by type (skip ORGANIC — not leaderboard-worthy)
  const byType = new Map<string, string[]>();
  for (const w of wallets) {
    if (w.type === "ORGANIC") continue;
    const list = byType.get(w.type) ?? [];
    list.push(w.address);
    byType.set(w.type, list);
  }

  const writes = [...byType.entries()].map(async ([type, addresses]) => {
    const key = `${INDEX_PREFIX}${type}`;
    const existing = ((await kv.get(key, "json")) as string[] | null) ?? [];
    const existingSet = new Set(existing);
    const newAddrs = addresses.filter((a) => !existingSet.has(a));
    if (newAddrs.length === 0) return;

    const updated = [...existing, ...newAddrs].slice(-MAX_INDEX_SIZE);
    await kv.put(key, JSON.stringify(updated), {
      expirationTtl: INDEX_TTL_SECONDS,
    });
  });

  await Promise.allSettled(writes);
}

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
};
