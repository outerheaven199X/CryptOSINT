/**
 * Cloudflare Pages Function: POST /api/replay
 * Reconstructs the lifecycle of a rugged token as a timeline.
 * Cached in KV for 7 days per mint.
 */

import {
  getTransactionsForToken,
  getTokenMetadata,
} from "../../src/lib/helius";
import type { ParsedTransaction } from "../../src/lib/helius";
import {
  buildWalletProfiles,
  classifyAllWallets,
} from "../../src/lib/classify";
import type {
  WalletType,
  ClassifiedWallet,
  TimelineEvent,
  TimelineEventType,
  ReplayResult,
  RugMethod,
} from "../../src/lib/types";

interface Env {
  HELIUS_API_KEY: string;
  SKNWLKR_CACHE: KVNamespace;
}

const REPLAY_KV_PREFIX = "replay:";
const REPLAY_TTL_SECONDS = 7 * 24 * 60 * 60;
const LARGE_SELL_THRESHOLD_PCT = 5;
const MASS_DUMP_WINDOW_S = 60;
const MASS_DUMP_MIN_SELLERS = 3;

const RAYDIUM_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
]);
const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = (await context.request.json()) as { mint: string };
    const mint = body.mint?.trim();

    if (!mint || mint.length < 32) {
      return jsonError("Invalid token mint address", 400);
    }

    const apiKey = context.env.HELIUS_API_KEY;
    if (!apiKey) {
      return jsonError("Server misconfigured: missing API key", 500);
    }

    const kv = context.env.SKNWLKR_CACHE;

    // Check KV cache
    const cached = await kv.get(
      `${REPLAY_KV_PREFIX}${mint}`,
      "json",
    ) as ReplayResult | null;
    if (cached) {
      return new Response(JSON.stringify(cached), {
        status: 200,
        headers: CORS_HEADERS,
      });
    }

    // Fetch data
    const [metadata, transactions] = await Promise.all([
      getTokenMetadata(mint, apiKey),
      getTransactionsForToken(mint, apiKey, 500),
    ]);

    if (transactions.length === 0) {
      return jsonError("No transactions found for this token", 404);
    }

    const sortedTxs = [...transactions].sort((a, b) => a.slot - b.slot);
    const createdAt = sortedTxs[0].timestamp;
    const deployerAddress = sortedTxs[0].feePayer;

    // Classify wallets
    const profiles = buildWalletProfiles(transactions, mint, deployerAddress);
    const totalSupply = profiles.reduce(
      (s, p) => s + Math.max(0, p.currentHolding), 0,
    );
    const classified = classifyAllWallets(profiles, totalSupply);
    const walletTypeMap = buildWalletTypeMap(classified);

    // Build timeline
    const timeline = buildTimeline(
      sortedTxs, mint, createdAt, walletTypeMap, totalSupply,
    );

    // Compute summary
    const summary = buildSummary(
      classified, timeline, createdAt, sortedTxs,
    );

    const walletBreakdown = countByType(classified);

    const result: ReplayResult = {
      token: {
        name: metadata.name,
        symbol: metadata.symbol,
        mint,
        createdAt,
      },
      timeline,
      summary,
      walletBreakdown,
    };

    // Cache in background
    context.waitUntil(
      kv.put(`${REPLAY_KV_PREFIX}${mint}`, JSON.stringify(result), {
        expirationTtl: REPLAY_TTL_SECONDS,
      }),
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: CORS_HEADERS,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Internal server error";
    console.error("Replay error:", msg);
    return jsonError(msg, 500);
  }
};

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

// ── Helpers ──

function jsonError(message: string, status: number): Response {
  return new Response(
    JSON.stringify({ error: message }),
    { status, headers: CORS_HEADERS },
  );
}

function buildWalletTypeMap(
  wallets: ClassifiedWallet[],
): Map<string, WalletType> {
  const map = new Map<string, WalletType>();
  for (const w of wallets) {
    map.set(w.address, w.type);
  }
  return map;
}

function countByType(
  wallets: ClassifiedWallet[],
): Record<WalletType, number> {
  const counts: Record<WalletType, number> = {
    AGENT: 0, INSIDER: 0, COPY: 0, SNIPER: 0, ORGANIC: 0,
  };
  for (const w of wallets) counts[w.type]++;
  return counts;
}

function formatRelativeTime(timestamp: number, origin: number): string {
  const diff = timestamp - origin;
  if (diff <= 0) return "+0s";
  if (diff < 60) return `+${diff}s`;
  const mins = Math.floor(diff / 60);
  const secs = diff % 60;
  if (mins < 60) return secs > 0 ? `+${mins}m ${secs}s` : `+${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `+${hrs}h ${remMins}m` : `+${hrs}h`;
}

// ── Timeline builder ──

function buildTimeline(
  sortedTxs: ParsedTransaction[],
  mint: string,
  createdAt: number,
  walletTypeMap: Map<string, WalletType>,
  totalSupply: number,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const seenBuyers = new Set<string>();
  const organicBuckets = new Map<number, number>(); // minute -> count

  // CREATION event
  events.push({
    timestamp: createdAt,
    relativeTime: "+0s",
    type: "CREATION",
    wallet: sortedTxs[0].feePayer,
    walletType: "INSIDER",
    detail: "Token created",
  });

  for (const tx of sortedTxs) {
    // Check LP removal
    if (isLpTransaction(tx)) {
      const lpEvent = detectLpRemovalEvent(
        tx, mint, createdAt, walletTypeMap,
      );
      if (lpEvent) events.push(lpEvent);
    }

    // Process token transfers
    for (const transfer of tx.tokenTransfers) {
      if (transfer.mint !== mint) continue;

      const buyer = transfer.toUserAccount;
      const seller = transfer.fromUserAccount;
      const supplyPct = totalSupply > 0
        ? (transfer.tokenAmount / totalSupply) * 100
        : 0;

      // Buy events
      if (buyer && !seenBuyers.has(buyer)) {
        seenBuyers.add(buyer);
        const wType = walletTypeMap.get(buyer) ?? "ORGANIC";
        const event = buildBuyEvent(
          tx.timestamp, createdAt, buyer, wType, supplyPct,
        );
        if (event) {
          if (event.type === "ORGANIC_BUY") {
            aggregateOrganicBuy(organicBuckets, tx.timestamp);
          } else {
            events.push(event);
          }
        }
      }

      // Sell events
      if (seller && supplyPct >= LARGE_SELL_THRESHOLD_PCT) {
        const wType = walletTypeMap.get(seller) ?? "ORGANIC";
        events.push({
          timestamp: tx.timestamp,
          relativeTime: formatRelativeTime(tx.timestamp, createdAt),
          type: "LARGE_SELL",
          wallet: seller,
          walletType: wType,
          detail: `${truncate(seller)} sold ${supplyPct.toFixed(1)}% of supply`,
          supplyPercent: supplyPct,
        });
      }
    }
  }

  // Add aggregated organic buys
  for (const [minuteTs, count] of organicBuckets) {
    events.push({
      timestamp: minuteTs,
      relativeTime: formatRelativeTime(minuteTs, createdAt),
      type: "ORGANIC_BUY",
      wallet: "",
      walletType: "ORGANIC",
      detail: `${count} organic buyer${count > 1 ? "s" : ""} entered`,
    });
  }

  // Detect mass dumps
  const massDumps = detectMassDumps(
    events.filter((e) => e.type === "LARGE_SELL"),
    createdAt,
  );
  events.push(...massDumps);

  // Sort chronologically
  events.sort((a, b) => a.timestamp - b.timestamp);

  return events;
}

function buildBuyEvent(
  timestamp: number,
  createdAt: number,
  buyer: string,
  wType: WalletType,
  supplyPct: number,
): TimelineEvent | null {
  const relativeTime = formatRelativeTime(timestamp, createdAt);
  const typeMap: Partial<Record<WalletType, TimelineEventType>> = {
    INSIDER: "INSIDER_BUY",
    AGENT: "BOT_ENTRY",
    SNIPER: "SNIPER_ENTRY",
    ORGANIC: "ORGANIC_BUY",
    COPY: "ORGANIC_BUY",
  };
  const eventType = typeMap[wType] ?? "ORGANIC_BUY";
  const label = wType === "ORGANIC" || wType === "COPY" ? wType : wType;

  return {
    timestamp,
    relativeTime,
    type: eventType,
    wallet: buyer,
    walletType: wType,
    detail: `${truncate(buyer)} bought (${label}) — ${supplyPct.toFixed(1)}% supply`,
    supplyPercent: supplyPct,
  };
}

function aggregateOrganicBuy(
  buckets: Map<number, number>,
  timestamp: number,
): void {
  // Bucket to the nearest minute
  const SECONDS_PER_MINUTE = 60;
  const minuteTs = Math.floor(timestamp / SECONDS_PER_MINUTE) * SECONDS_PER_MINUTE;
  buckets.set(minuteTs, (buckets.get(minuteTs) ?? 0) + 1);
}

function isLpTransaction(tx: ParsedTransaction): boolean {
  return tx.accountData.some(
    (a) => RAYDIUM_PROGRAMS.has(a.account) || a.account === ORCA_WHIRLPOOL,
  );
}

function detectLpRemovalEvent(
  tx: ParsedTransaction,
  mint: string,
  createdAt: number,
  walletTypeMap: Map<string, WalletType>,
): TimelineEvent | null {
  const LAMPORTS_PER_SOL = 1_000_000_000;
  const feePayer = tx.feePayer;
  const feePayerData = tx.accountData.find((a) => a.account === feePayer);
  const solGain = feePayerData
    ? feePayerData.nativeBalanceChange / LAMPORTS_PER_SOL
    : 0;

  if (solGain <= 0) return null;

  return {
    timestamp: tx.timestamp,
    relativeTime: formatRelativeTime(tx.timestamp, createdAt),
    type: "LP_REMOVE",
    wallet: feePayer,
    walletType: walletTypeMap.get(feePayer) ?? "ORGANIC",
    detail: `LP removed — ${solGain.toFixed(1)} SOL withdrawn by ${truncate(feePayer)}`,
    amountSol: solGain,
  };
}

function detectMassDumps(
  sellEvents: TimelineEvent[],
  createdAt: number,
): TimelineEvent[] {
  if (sellEvents.length < MASS_DUMP_MIN_SELLERS) return [];

  const sorted = [...sellEvents].sort((a, b) => a.timestamp - b.timestamp);
  const result: TimelineEvent[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < sorted.length; i++) {
    const windowEnd = sorted[i].timestamp + MASS_DUMP_WINDOW_S;
    const cluster = sorted.filter(
      (e) => e.timestamp >= sorted[i].timestamp && e.timestamp <= windowEnd,
    );
    const unique = new Set(cluster.map((e) => e.wallet));

    if (unique.size >= MASS_DUMP_MIN_SELLERS && !seen.has(sorted[i].timestamp)) {
      seen.add(sorted[i].timestamp);
      result.push({
        timestamp: sorted[i].timestamp,
        relativeTime: formatRelativeTime(sorted[i].timestamp, createdAt),
        type: "MASS_DUMP",
        wallet: "",
        walletType: "INSIDER",
        detail: `${unique.size} wallets dumped within ${MASS_DUMP_WINDOW_S}s`,
      });
    }
  }

  return result;
}

// ── Summary ──

function buildSummary(
  classified: ClassifiedWallet[],
  timeline: TimelineEvent[],
  createdAt: number,
  sortedTxs: ParsedTransaction[],
): ReplayResult["summary"] {
  const lastTs = sortedTxs[sortedTxs.length - 1]?.timestamp ?? createdAt;
  const lifespanS = lastTs - createdAt;
  const lifespan = formatLifespan(lifespanS);

  const peakHolders = classified.length;

  const organicWallets = classified.filter((w) => w.type === "ORGANIC");
  const organicLoss = organicWallets.reduce(
    (sum, w) => sum + Math.min(0, w.pnlSol), 0,
  );

  const insiderWallets = classified.filter(
    (w) => w.type === "INSIDER" || w.type === "AGENT",
  );
  const insiderProfit = insiderWallets.reduce(
    (sum, w) => sum + Math.max(0, w.pnlSol), 0,
  );

  const rugMethod = detectRugMethod(timeline);

  return {
    lifespan,
    peakHolders,
    organicLossEstimate: Math.abs(organicLoss),
    insiderProfitEstimate: insiderProfit,
    rugMethod,
  };
}

function formatLifespan(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins} minute${mins > 1 ? "s" : ""}`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) {
    return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs} hour${hrs > 1 ? "s" : ""}`;
  }
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? "s" : ""}`;
}

function detectRugMethod(timeline: TimelineEvent[]): RugMethod {
  const hasLpPull = timeline.some((e) => e.type === "LP_REMOVE");
  const hasMassDump = timeline.some((e) => e.type === "MASS_DUMP");

  if (hasLpPull) return "LP_PULL";
  if (hasMassDump) return "MASS_DUMP";
  return "UNKNOWN";
}

function truncate(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
}
