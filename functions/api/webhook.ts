/**
 * Cloudflare Pages Function: POST /api/webhook
 * Receives enhanced transaction data from Helius webhooks.
 * Checks transacting wallets against KV classifications.
 * Writes alert events to KV for the threat feed.
 *
 * Must respond 200 within 10 seconds or Helius retries.
 */

import type {
  WalletType,
  WalletRecord,
  ThreatEvent,
  ThreatType,
  ThreatSeverity,
  WatchedToken,
} from "../../src/lib/types";

interface Env {
  SKNWLKR_CACHE: KVNamespace;
}

const WALLET_KV_PREFIX = "wallet:";
const WATCH_KV_PREFIX = "watch:";
const ALERT_KV_PREFIX = "alert:";
const ALERT_TTL_SECONDS = 24 * 60 * 60;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MIN_ALERT_SOL = 1;

/** Helius enhanced transaction shape (simplified). */
interface HeliusWebhookTx {
  signature: string;
  timestamp: number;
  feePayer: string;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
  }>;
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
  }>;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // Always respond 200 quickly — process in background
  const body = await context.request.json() as HeliusWebhookTx[];

  context.waitUntil(processWebhookBatch(body, context.env.SKNWLKR_CACHE));

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
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

// ── Processing ──

async function processWebhookBatch(
  transactions: HeliusWebhookTx[],
  kv: KVNamespace,
): Promise<void> {
  for (const tx of transactions) {
    await processTransaction(tx, kv).catch((err) => {
      console.error("Webhook tx processing error:", err);
    });
  }
}

async function processTransaction(
  tx: HeliusWebhookTx,
  kv: KVNamespace,
): Promise<void> {
  // Collect all unique wallet addresses from transfers
  const wallets = extractWalletAddresses(tx);
  const mints = extractMints(tx);

  // Look up classifications for each wallet
  const classifications = await lookupClassifications(wallets, kv);
  if (classifications.size === 0) return;

  // Look up token symbol from watch list
  const tokenInfo = await resolveTokenInfo(mints, kv);

  // Generate alerts for flagged wallets
  const alerts = buildAlerts(tx, classifications, tokenInfo);

  // Write alerts to KV
  const writes = alerts.map((alert) =>
    kv.put(
      `${ALERT_KV_PREFIX}${alert.timestamp}:${alert.id}`,
      JSON.stringify(alert),
      { expirationTtl: ALERT_TTL_SECONDS },
    ),
  );

  await Promise.allSettled(writes);
}

function extractWalletAddresses(tx: HeliusWebhookTx): string[] {
  const addrs = new Set<string>();
  addrs.add(tx.feePayer);

  for (const nt of tx.nativeTransfers ?? []) {
    addrs.add(nt.fromUserAccount);
    addrs.add(nt.toUserAccount);
  }
  for (const tt of tx.tokenTransfers ?? []) {
    if (tt.fromUserAccount) addrs.add(tt.fromUserAccount);
    if (tt.toUserAccount) addrs.add(tt.toUserAccount);
  }

  return [...addrs].filter(Boolean);
}

function extractMints(tx: HeliusWebhookTx): string[] {
  const mints = new Set<string>();
  for (const tt of tx.tokenTransfers ?? []) {
    if (tt.mint) mints.add(tt.mint);
  }
  return [...mints];
}

async function lookupClassifications(
  addresses: string[],
  kv: KVNamespace,
): Promise<Map<string, WalletType>> {
  const result = new Map<string, WalletType>();

  const settled = await Promise.allSettled(
    addresses.map((addr) => kv.get(`${WALLET_KV_PREFIX}${addr}`, "json")),
  );

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status !== "fulfilled" || !outcome.value) continue;

    const records = outcome.value as WalletRecord[];
    if (records.length === 0) continue;

    // Use the most recent classification
    const sorted = [...records].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    result.set(addresses[i], sorted[0].classification);
  }

  return result;
}

async function resolveTokenInfo(
  mints: string[],
  kv: KVNamespace,
): Promise<Map<string, { symbol: string; mint: string }>> {
  const result = new Map<string, { symbol: string; mint: string }>();

  const settled = await Promise.allSettled(
    mints.map((mint) => kv.get(`${WATCH_KV_PREFIX}${mint}`, "json")),
  );

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status !== "fulfilled" || !outcome.value) continue;
    const watched = outcome.value as WatchedToken;
    result.set(mints[i], { symbol: watched.symbol, mint: mints[i] });
  }

  return result;
}

function buildAlerts(
  tx: HeliusWebhookTx,
  classifications: Map<string, WalletType>,
  tokenInfo: Map<string, { symbol: string; mint: string }>,
): ThreatEvent[] {
  const alerts: ThreatEvent[] = [];
  const timestamp = new Date(tx.timestamp * 1000).toISOString();
  const HIGH_VALUE_TYPES = new Set<WalletType>(["INSIDER", "AGENT"]);

  for (const tt of tx.tokenTransfers ?? []) {
    const info = tokenInfo.get(tt.mint);
    if (!info) continue;

    // Check seller
    if (tt.fromUserAccount && classifications.has(tt.fromUserAccount)) {
      const wType = classifications.get(tt.fromUserAccount)!;
      const alert = buildSellAlert(
        tx.signature, timestamp, tt.fromUserAccount, wType,
        info.symbol, info.mint, tt.tokenAmount,
        HIGH_VALUE_TYPES.has(wType),
      );
      if (alert) alerts.push(alert);
    }

    // Check buyer
    if (tt.toUserAccount && classifications.has(tt.toUserAccount)) {
      const wType = classifications.get(tt.toUserAccount)!;
      const alert = buildBuyAlert(
        tx.signature, timestamp, tt.toUserAccount, wType,
        info.symbol, info.mint, tt.tokenAmount,
      );
      if (alert) alerts.push(alert);
    }
  }

  // Check native SOL transfers for large movements
  for (const nt of tx.nativeTransfers ?? []) {
    const solAmount = nt.amount / LAMPORTS_PER_SOL;
    if (solAmount < MIN_ALERT_SOL) continue;

    const fromType = classifications.get(nt.fromUserAccount);
    if (fromType && HIGH_VALUE_TYPES.has(fromType)) {
      // Find any token context
      const firstToken = [...tokenInfo.values()][0];
      alerts.push({
        id: `${tx.signature}-sol`,
        timestamp,
        type: "INSIDER_MOVE",
        severity: solAmount > 10 ? "CRITICAL" : "HIGH",
        tokenSymbol: firstToken?.symbol ?? "SOL",
        tokenMint: firstToken?.mint ?? "",
        detail: `${truncate(nt.fromUserAccount)} (${fromType}) moved ${solAmount.toFixed(1)} SOL to ${truncate(nt.toUserAccount)}`,
        wallet: nt.fromUserAccount,
        walletType: fromType,
        amountSol: solAmount,
      });
    }
  }

  return alerts;
}

function buildSellAlert(
  signature: string,
  timestamp: string,
  wallet: string,
  walletType: WalletType,
  symbol: string,
  mint: string,
  tokenAmount: number,
  isHighValue: boolean,
): ThreatEvent | null {
  const alertType: ThreatType = isHighValue ? "INSIDER_MOVE" : "WHALE_SELL";
  const severity: ThreatSeverity = isHighValue ? "CRITICAL" : "HIGH";

  return {
    id: `${signature}-sell-${wallet.slice(0, 8)}`,
    timestamp,
    type: alertType,
    severity,
    tokenSymbol: symbol,
    tokenMint: mint,
    detail: `${truncate(wallet)} (${walletType}) sold ${formatAmount(tokenAmount)} $${symbol}`,
    wallet,
    walletType,
  };
}

function buildBuyAlert(
  signature: string,
  timestamp: string,
  wallet: string,
  walletType: WalletType,
  symbol: string,
  mint: string,
  tokenAmount: number,
): ThreatEvent | null {
  if (walletType === "ORGANIC" || walletType === "COPY") return null;

  return {
    id: `${signature}-buy-${wallet.slice(0, 8)}`,
    timestamp,
    type: "LARGE_BUY",
    severity: "MEDIUM",
    tokenSymbol: symbol,
    tokenMint: mint,
    detail: `${truncate(wallet)} (${walletType}) bought ${formatAmount(tokenAmount)} $${symbol}`,
    wallet,
    walletType,
  };
}

function truncate(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(2);
}
