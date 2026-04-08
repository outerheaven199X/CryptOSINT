/**
 * LP event detection heuristics.
 * Analyzes Raydium/Orca LP removal transactions to flag potential rugs.
 */

import type { ParsedTransaction } from "./helius";
import type { ThreatEvent, ThreatSeverity } from "./types";

/** Well-known Raydium AMM program IDs. */
const RAYDIUM_PROGRAMS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM V4
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
]);

/** Well-known Orca Whirlpool program. */
const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

/** Minimum SOL removed to flag as a threat. */
const MIN_LP_REMOVAL_SOL = 5;

/** Percentage thresholds for severity. */
const CRITICAL_LP_PCT = 80;
const HIGH_LP_PCT = 50;

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Detect LP removal events from parsed transactions.
 * Returns threat events for any transaction that removes significant liquidity.
 */
export function detectLpRemovals(
  transactions: ParsedTransaction[],
  tokenMint: string,
  tokenSymbol: string,
): ThreatEvent[] {
  const threats: ThreatEvent[] = [];

  for (const tx of transactions) {
    if (!isLpRelatedTransaction(tx)) continue;

    const removal = analyzeLpRemoval(tx, tokenMint);
    if (!removal || removal.solRemoved < MIN_LP_REMOVAL_SOL) continue;

    const severity = classifyRemovalSeverity(removal.lpPctRemoved);

    threats.push({
      id: tx.signature,
      timestamp: new Date(tx.timestamp * 1000).toISOString(),
      type: "RUG",
      severity,
      tokenSymbol,
      tokenMint,
      detail: buildRemovalDetail(removal, tokenSymbol),
      lpRemovedSol: removal.solRemoved,
      lpRemovedPct: removal.lpPctRemoved,
      removerAddress: removal.removerAddress,
    });
  }

  return threats;
}

/** Check if a transaction interacts with known AMM programs. */
function isLpRelatedTransaction(tx: ParsedTransaction): boolean {
  return tx.accountData.some(
    (a) => RAYDIUM_PROGRAMS.has(a.account) || a.account === ORCA_WHIRLPOOL,
  );
}

interface LpRemovalResult {
  solRemoved: number;
  lpPctRemoved: number;
  removerAddress: string;
}

/**
 * Analyze a single transaction for LP removal patterns.
 *
 * Heuristic: look for the fee payer receiving a large SOL inflow
 * while token balance decreases (liquidity being withdrawn).
 */
function analyzeLpRemoval(
  tx: ParsedTransaction,
  tokenMint: string,
): LpRemovalResult | null {
  const feePayer = tx.feePayer;

  // Find net SOL gain for the fee payer
  const feePayerAccount = tx.accountData.find(
    (a) => a.account === feePayer,
  );
  const solGain = feePayerAccount
    ? feePayerAccount.nativeBalanceChange / LAMPORTS_PER_SOL
    : 0;

  // Must be receiving SOL, not spending it
  if (solGain <= 0) return null;

  // Check for token outflow (LP token being burned or token being received back)
  const tokenOutflow = tx.tokenTransfers.some(
    (t) => t.mint === tokenMint && t.fromUserAccount !== feePayer,
  );
  const tokenInflow = tx.tokenTransfers.some(
    (t) => t.mint === tokenMint && t.toUserAccount === feePayer,
  );

  // LP removal pattern: user gets SOL + token back, LP pool loses both
  if (!tokenOutflow && !tokenInflow) return null;

  // Estimate LP percentage removed (rough — based on SOL magnitude)
  // Without pool state we can't get exact %, so we use SOL thresholds
  const estimatedPct = estimateLpPercentage(solGain);

  return {
    solRemoved: solGain,
    lpPctRemoved: estimatedPct,
    removerAddress: feePayer,
  };
}

/**
 * Rough LP percentage estimate based on SOL magnitude.
 * Real implementation would query pool reserves.
 */
function estimateLpPercentage(solRemoved: number): number {
  if (solRemoved > 100) return 95;
  if (solRemoved > 50) return 80;
  if (solRemoved > 20) return 60;
  if (solRemoved > 10) return 40;
  return 20;
}

function classifyRemovalSeverity(lpPct: number): ThreatSeverity {
  if (lpPct >= CRITICAL_LP_PCT) return "CRITICAL";
  if (lpPct >= HIGH_LP_PCT) return "HIGH";
  return "MEDIUM";
}

function buildRemovalDetail(
  removal: LpRemovalResult,
  symbol: string,
): string {
  const solStr = removal.solRemoved.toFixed(1);
  const pctStr = removal.lpPctRemoved.toFixed(0);
  const addr = truncate(removal.removerAddress);

  if (removal.lpPctRemoved >= CRITICAL_LP_PCT) {
    return `LP removed — ${solStr} SOL (~${pctStr}% of pool) pulled by ${addr}. $${symbol} likely rugged.`;
  }
  if (removal.lpPctRemoved >= HIGH_LP_PCT) {
    return `Major LP withdrawal — ${solStr} SOL (~${pctStr}%) removed by ${addr}. Significant liquidity reduction for $${symbol}.`;
  }
  return `LP reduction detected — ${solStr} SOL (~${pctStr}%) withdrawn by ${addr} from $${symbol} pool.`;
}

function truncate(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : addr;
}

/**
 * Detect coordinated dump patterns: multiple classified insiders
 * selling within a short time window.
 */
export function detectCoordinatedDumps(
  transactions: ParsedTransaction[],
  tokenMint: string,
  tokenSymbol: string,
  insiderAddresses: Set<string>,
): ThreatEvent[] {
  if (insiderAddresses.size === 0) return [];

  const DUMP_WINDOW_SECONDS = 300; // 5 minutes
  const MIN_DUMPERS = 2;

  // Find sell transactions by insiders
  const insiderSells: Array<{ address: string; timestamp: number; signature: string }> = [];

  for (const tx of transactions) {
    for (const transfer of tx.tokenTransfers) {
      if (transfer.mint !== tokenMint) continue;
      if (!insiderAddresses.has(transfer.fromUserAccount)) continue;

      insiderSells.push({
        address: transfer.fromUserAccount,
        timestamp: tx.timestamp,
        signature: tx.signature,
      });
    }
  }

  if (insiderSells.length < MIN_DUMPERS) return [];

  // Sort by time and find clusters
  insiderSells.sort((a, b) => a.timestamp - b.timestamp);
  const threats: ThreatEvent[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < insiderSells.length; i++) {
    const windowStart = insiderSells[i].timestamp;
    const windowEnd = windowStart + DUMP_WINDOW_SECONDS;
    const cluster = insiderSells.filter(
      (s) => s.timestamp >= windowStart && s.timestamp <= windowEnd,
    );
    const uniqueAddresses = new Set(cluster.map((s) => s.address));

    if (uniqueAddresses.size >= MIN_DUMPERS) {
      const clusterKey = cluster.map((s) => s.signature).sort().join(",");
      if (seen.has(clusterKey)) continue;
      seen.add(clusterKey);

      threats.push({
        id: `dump-${cluster[0].signature}`,
        timestamp: new Date(windowStart * 1000).toISOString(),
        type: "BUNDLE",
        severity: uniqueAddresses.size >= 4 ? "CRITICAL" : "HIGH",
        tokenSymbol,
        tokenMint,
        detail: `${uniqueAddresses.size} insider wallets sold $${tokenSymbol} within ${Math.ceil(DUMP_WINDOW_SECONDS / 60)}min window. Coordinated dump pattern detected.`,
      });
    }
  }

  return threats;
}
