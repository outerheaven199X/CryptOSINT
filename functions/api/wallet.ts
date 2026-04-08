/**
 * Cloudflare Pages Function: POST /api/wallet
 * Scans a wallet address across all tokens it touched.
 * Classifies per-token behavior and builds a funding graph.
 */

import {
  getTransactionsForToken,
  getTokenMetadataBatch,
  getWalletOrigin,
} from "../../src/lib/helius";
import type { ParsedTransaction, WalletOrigin } from "../../src/lib/helius";
import {
  classifyWalletForToken,
  generateWalletVerdict,
  computeReputation,
} from "../../src/lib/classify";
import type {
  WalletScanResult,
  WalletTokenEntry,
  WalletRecord,
  PriorRecord,
  FundingEntry,
} from "../../src/lib/types";

interface Env {
  HELIUS_API_KEY: string;
  SKNWLKR_CACHE: KVNamespace;
}

const KV_PREFIX = "wallet:";

const LAMPORTS_PER_SOL = 1_000_000_000;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  try {
    const body = (await context.request.json()) as { address: string };
    const address = body.address?.trim();

    if (!address || address.length < 32) {
      return new Response(
        JSON.stringify({ error: "Invalid wallet address" }),
        { status: 400, headers: corsHeaders },
      );
    }

    const apiKey = context.env.HELIUS_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server misconfigured: missing API key" }),
        { status: 500, headers: corsHeaders },
      );
    }

    const transactions = await getTransactionsForToken(address, apiKey, 500);

    if (transactions.length === 0) {
      return new Response(
        JSON.stringify({ error: "No transactions found for this wallet" }),
        { status: 404, headers: corsHeaders },
      );
    }

    const uniqueMints = extractUniqueMints(transactions, address);
    const metadata = await getTokenMetadataBatch(uniqueMints, apiKey);
    const tokens = classifyPerToken(transactions, address, uniqueMints, metadata);
    const associations = buildFundingGraph(transactions, address);
    const verdict = generateWalletVerdict(tokens);
    const walletStats = computeWalletStats(tokens, transactions, address, associations);

    // KV read: look up this wallet's prior scan history
    const priorHistory = await readPriorHistory(address, context.env.SKNWLKR_CACHE);
    if (priorHistory.length > 0) {
      walletStats.priorHistory = priorHistory;
    }

    // Wallet age & origin (cached in KV)
    const originKey = `origin:${address}`;
    let origin = (await context.env.SKNWLKR_CACHE.get(originKey, "json")) as WalletOrigin | null;
    if (!origin) {
      origin = await getWalletOrigin(address, apiKey);
      await context.env.SKNWLKR_CACHE.put(originKey, JSON.stringify(origin), {
        expirationTtl: 30 * 24 * 60 * 60,
      });
    }
    if (origin.firstTxTimestamp > 0) {
      walletStats.walletAge = formatWalletAge(origin.firstTxTimestamp);
    }
    if (origin.firstFunder) {
      walletStats.firstFunder = origin.firstFunder;
      walletStats.firstFundAmountSol = origin.firstFundAmount;
    }

    // Compute reputation score from prior history + current scan
    const reputationHistory = [
      ...priorHistory.map((p) => ({
        tokenMint: "",
        tokenSymbol: p.tokenSymbol,
        classification: p.classification,
        entryBlock: 0,
        timestamp: p.timestamp,
      })),
      ...tokens.map((t) => ({
        tokenMint: t.mint,
        tokenSymbol: t.symbol,
        classification: t.classification,
        entryBlock: t.entryBlock,
        timestamp: t.firstTx,
      })),
    ];
    if (reputationHistory.length > 0) {
      walletStats.reputation = computeReputation(
        reputationHistory,
        walletStats.walletAge,
        associations.fundedWallets.length,
      );
    }

    const result: WalletScanResult = {
      wallet: walletStats,
      tokens: sortTokensByPnl(tokens),
      associations,
      verdict,
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    console.error("Wallet scan error:", err);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: corsHeaders },
    );
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

function extractUniqueMints(
  txs: ParsedTransaction[],
  wallet: string,
): string[] {
  const mints = new Set<string>();
  for (const tx of txs) {
    for (const t of tx.tokenTransfers) {
      if (t.fromUserAccount === wallet || t.toUserAccount === wallet) {
        mints.add(t.mint);
      }
    }
  }
  return [...mints];
}

function classifyPerToken(
  txs: ParsedTransaction[],
  wallet: string,
  mints: string[],
  metadata: Map<string, { name: string; symbol: string }>,
): WalletTokenEntry[] {
  return mints.map((mint) => {
    const result = classifyWalletForToken(txs, wallet, mint);
    const meta = metadata.get(mint) ?? { name: "Unknown", symbol: mint.slice(0, 6) };

    const firstTxTime = txs
      .filter((tx) => tx.tokenTransfers.some((t) => t.mint === mint))
      .sort((a, b) => a.slot - b.slot)[0]?.timestamp ?? 0;

    return {
      mint,
      symbol: meta.symbol,
      name: meta.name,
      classification: result.classification,
      entryBlock: result.entryBlock,
      pnlSol: result.pnlSol,
      buyAmount: result.buyAmount,
      sellAmount: result.sellAmount,
      holdingAmount: result.holdingAmount,
      firstTx: firstTxTime ? new Date(firstTxTime * 1000).toISOString() : "",
      tag: result.tag,
    };
  });
}

function buildFundingGraph(
  txs: ParsedTransaction[],
  wallet: string,
): { fundingSources: FundingEntry[]; fundedWallets: FundingEntry[] } {
  const inbound = new Map<string, { total: number; latest: number }>();
  const outbound = new Map<string, { total: number; latest: number }>();

  for (const tx of txs) {
    for (const nt of tx.nativeTransfers) {
      if (nt.toUserAccount === wallet && nt.fromUserAccount !== wallet) {
        const prev = inbound.get(nt.fromUserAccount) ?? { total: 0, latest: 0 };
        prev.total += nt.amount;
        prev.latest = Math.max(prev.latest, tx.timestamp);
        inbound.set(nt.fromUserAccount, prev);
      }
      if (nt.fromUserAccount === wallet && nt.toUserAccount !== wallet) {
        const prev = outbound.get(nt.toUserAccount) ?? { total: 0, latest: 0 };
        prev.total += nt.amount;
        prev.latest = Math.max(prev.latest, tx.timestamp);
        outbound.set(nt.toUserAccount, prev);
      }
    }
  }

  const toEntries = (m: Map<string, { total: number; latest: number }>): FundingEntry[] =>
    [...m.entries()]
      .map(([addr, v]) => ({
        address: addr,
        amountSol: v.total / LAMPORTS_PER_SOL,
        timestamp: v.latest ? new Date(v.latest * 1000).toISOString() : "",
      }))
      .sort((a, b) => b.amountSol - a.amountSol)
      .slice(0, 20);

  return {
    fundingSources: toEntries(inbound),
    fundedWallets: toEntries(outbound),
  };
}

function computeWalletStats(
  tokens: WalletTokenEntry[],
  txs: ParsedTransaction[],
  address: string,
  associations: { fundingSources: FundingEntry[]; fundedWallets: FundingEntry[] },
): WalletScanResult["wallet"] {
  const totalPnlSol = tokens.reduce((sum, t) => sum + t.pnlSol, 0);
  const wins = tokens.filter((t) => t.pnlSol > 0).length;
  const winRate = tokens.length > 0 ? Math.round((wins / tokens.length) * 100) : 0;

  const sorted = [...txs].sort((a, b) => a.slot - b.slot);
  const firstTs = sorted[0]?.timestamp ?? 0;

  return {
    address,
    totalPnlSol,
    totalTokensTouched: tokens.length,
    winRate,
    firstActivity: firstTs ? new Date(firstTs * 1000).toISOString() : "",
    fundedBy: associations.fundingSources.map((f) => f.address),
    fundedAddresses: associations.fundedWallets.map((f) => f.address),
  };
}

function sortTokensByPnl(tokens: WalletTokenEntry[]): WalletTokenEntry[] {
  return [...tokens].sort((a, b) => b.pnlSol - a.pnlSol);
}

function formatWalletAge(firstTxTimestamp: number): string {
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
  if (seconds < YEAR) return `${Math.floor(seconds / MONTH)}mo`;
  const years = Math.floor(seconds / YEAR);
  const mo = Math.floor((seconds % YEAR) / MONTH);
  return mo > 0 ? `${years}y ${mo}mo` : `${years}y`;
}

async function readPriorHistory(
  address: string,
  kv: KVNamespace,
): Promise<PriorRecord[]> {
  try {
    const records = (await kv.get(`${KV_PREFIX}${address}`, "json")) as WalletRecord[] | null;
    if (!records || records.length === 0) return [];
    return records.map((r) => ({
      tokenSymbol: r.tokenSymbol,
      classification: r.classification,
      timestamp: r.timestamp,
    }));
  } catch {
    return [];
  }
}
