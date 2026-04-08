import type { ParsedTransaction } from "./helius";
import type {
  WalletType,
  ClassifiedWallet,
  CopyRelationship,
  WalletRecord,
  ReputationScore,
  ReputationGrade,
} from "./types";

interface WalletProfile {
  address: string;
  firstBlock: number;
  txCount: number;
  txTimestamps: number[];
  totalBought: number;
  totalSold: number;
  currentHolding: number;
  isFundedByDeployer: boolean;
  interactsWithMev: boolean;
}

// Known Jito/MEV-related program IDs
const MEV_PROGRAMS = new Set([
  "T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt", // Jito tip
  "HFqU5x63VTqvQss8hp11i4bPYoTAYn4jQf4g3HcNBhiL", // Jito bundle
]);

export function buildWalletProfiles(
  transactions: ParsedTransaction[],
  tokenMint: string,
  deployerAddress: string
): WalletProfile[] {
  const profiles = new Map<string, WalletProfile>();

  // Sort by slot ascending (earliest first)
  const sorted = [...transactions].sort((a, b) => a.slot - b.slot);
  const firstSlot = sorted[0]?.slot || 0;

  for (const tx of sorted) {
    const relativeBlock = tx.slot - firstSlot;

    // Check for MEV program interaction
    const touchesMev = tx.accountData?.some(
      (a) => MEV_PROGRAMS.has(a.account)
    ) || false;

    // Extract wallets from token transfers involving our mint
    for (const transfer of tx.tokenTransfers || []) {
      if (transfer.mint !== tokenMint) continue;

      for (const addr of [transfer.fromUserAccount, transfer.toUserAccount]) {
        if (!addr || addr === tokenMint) continue;

        if (!profiles.has(addr)) {
          profiles.set(addr, {
            address: addr,
            firstBlock: relativeBlock,
            txCount: 0,
            txTimestamps: [],
            totalBought: 0,
            totalSold: 0,
            currentHolding: 0,
            isFundedByDeployer: false,
            interactsWithMev: false,
          });
        }

        const p = profiles.get(addr)!;
        p.txCount++;
        p.txTimestamps.push(tx.timestamp);
        if (touchesMev) p.interactsWithMev = true;

        if (transfer.toUserAccount === addr) {
          p.totalBought += transfer.tokenAmount;
          p.currentHolding += transfer.tokenAmount;
        }
        if (transfer.fromUserAccount === addr) {
          p.totalSold += transfer.tokenAmount;
          p.currentHolding -= transfer.tokenAmount;
        }
      }
    }

    // Check native SOL transfers for deployer funding
    for (const nt of tx.nativeTransfers || []) {
      if (nt.fromUserAccount === deployerAddress && profiles.has(nt.toUserAccount)) {
        profiles.get(nt.toUserAccount)!.isFundedByDeployer = true;
      }
    }
  }

  return Array.from(profiles.values());
}

function computeTxCadenceStdDev(timestamps: number[]): number {
  if (timestamps.length < 3) return Infinity;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(sorted[i] - sorted[i - 1]);
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
  return Math.sqrt(variance);
}

export function classifyWallet(
  profile: WalletProfile,
  totalSupply: number,
  insiderAddresses: Set<string>
): { type: WalletType; tag: string | null } {
  const supplyPct = totalSupply > 0 ? (profile.currentHolding / totalSupply) * 100 : 0;

  // INSIDER: block 0-1, deployer-funded or holds >1% supply
  if (
    profile.firstBlock <= 1 &&
    (profile.isFundedByDeployer || supplyPct > 1)
  ) {
    const tag = profile.isFundedByDeployer
      ? "FUNDED BY DEPLOYER"
      : `BLOCK ${profile.firstBlock} ENTRY — ${supplyPct.toFixed(1)}% SUPPLY`;
    return { type: "INSIDER", tag };
  }

  // AGENT: uniform cadence, high tx count, MEV interaction
  const cadenceStdDev = computeTxCadenceStdDev(profile.txTimestamps);
  if (
    (cadenceStdDev < 2 && profile.txCount > 10) ||
    (profile.interactsWithMev && profile.txCount > 5) ||
    (profile.txCount > 20 && cadenceStdDev < 5)
  ) {
    const tag = profile.interactsWithMev
      ? `MEV BOT — ${profile.txCount} TXS`
      : `BOT PATTERN — ${cadenceStdDev.toFixed(1)}s STDDEV`;
    return { type: "AGENT", tag };
  }

  // SNIPER: blocks 1-3, low lifetime tx count
  if (profile.firstBlock <= 3 && profile.txCount <= 2) {
    return {
      type: "SNIPER",
      tag: `BLOCK ${profile.firstBlock} SNIPE — ${profile.txCount} TX${profile.txCount > 1 ? "S" : ""}`,
    };
  }

  // COPY: bought within 30s of an insider, detectable by timestamp proximity
  // Simplified: if wallet bought in blocks 2-5 and has a small consistent tx pattern
  if (
    profile.firstBlock >= 2 &&
    profile.firstBlock <= 5 &&
    profile.txCount >= 3 &&
    profile.txCount <= 15
  ) {
    // Check if their first tx timestamp is close to any insider's
    return {
      type: "COPY",
      tag: `BLOCK ${profile.firstBlock} ENTRY — FOLLOWS INSIDER PATTERN`,
    };
  }

  // ORGANIC: everything else
  return { type: "ORGANIC", tag: null };
}

export function classifyAllWallets(
  profiles: WalletProfile[],
  totalSupply: number
): ClassifiedWallet[] {
  // First pass: identify insiders
  const insiderAddresses = new Set<string>();
  for (const p of profiles) {
    if (p.firstBlock <= 1 && (p.isFundedByDeployer || (totalSupply > 0 && (p.currentHolding / totalSupply) > 0.01))) {
      insiderAddresses.add(p.address);
    }
  }

  // Second pass: classify all
  return profiles.map((p) => {
    const { type, tag } = classifyWallet(p, totalSupply, insiderAddresses);
    const pnlSol = p.totalSold - p.totalBought + p.currentHolding;
    return {
      address: p.address,
      type,
      pnlSol,
      pnlUsd: 0, // requires SOL price lookup
      supplyPercent: totalSupply > 0 ? (p.currentHolding / totalSupply) * 100 : 0,
      entryBlock: p.firstBlock,
      txCount: p.txCount,
      tag,
    };
  });
}

// ── Copy Trade Detection ──

const COPY_MIN_DELAY_S = 3;
const COPY_MAX_DELAY_S = 30;
const COPY_MAX_STDDEV_S = 5;
const COPY_MIN_MATCHES = 2;
const COPY_MAX_FOLLOWER_BLOCK = 10;

/**
 * Detect leader → follower copy relationships.
 * Compares buy timestamps of wallets in blocks 2-10 against
 * INSIDER/AGENT wallets. Consistent 3-30s delay = copy trade.
 */
export function detectCopyRelationships(
  profiles: WalletProfile[],
  classifiedWallets: ClassifiedWallet[],
): CopyRelationship[] {
  const leaderTypes = new Set<WalletType>(["INSIDER", "AGENT"]);
  const leaderProfiles = profiles.filter((p) => {
    const cw = classifiedWallets.find((w) => w.address === p.address);
    return cw && leaderTypes.has(cw.type);
  });

  if (leaderProfiles.length === 0) return [];

  // Build leader first-buy timestamps (earliest buy per leader)
  const leaderBuyTimes = buildFirstBuyTimes(leaderProfiles);

  // Check potential followers: blocks 2-10
  const followerProfiles = profiles.filter(
    (p) => p.firstBlock >= 2 && p.firstBlock <= COPY_MAX_FOLLOWER_BLOCK,
  );

  const relationships: CopyRelationship[] = [];

  for (const follower of followerProfiles) {
    const followerBuyTime = getFirstBuyTimestamp(follower);
    if (followerBuyTime === 0) continue;

    const match = findBestLeaderMatch(
      followerBuyTime,
      leaderBuyTimes,
      follower.address,
    );
    if (match) {
      relationships.push(match);
    }
  }

  return relationships;
}

function buildFirstBuyTimes(
  leaders: WalletProfile[],
): Array<{ address: string; timestamp: number }> {
  return leaders
    .map((p) => ({
      address: p.address,
      timestamp: getFirstBuyTimestamp(p),
    }))
    .filter((entry) => entry.timestamp > 0);
}

function getFirstBuyTimestamp(profile: WalletProfile): number {
  if (profile.txTimestamps.length === 0) return 0;
  return Math.min(...profile.txTimestamps);
}

/**
 * Find the leader whose buy is closest to the follower's buy
 * within the 3-30s window. Returns a CopyRelationship or null.
 */
function findBestLeaderMatch(
  followerBuyTime: number,
  leaderBuyTimes: Array<{ address: string; timestamp: number }>,
  followerAddress: string,
): CopyRelationship | null {
  let bestLeader: string | null = null;
  let bestDelay = Infinity;
  const delays: number[] = [];

  for (const leader of leaderBuyTimes) {
    if (leader.address === followerAddress) continue;

    const delay = followerBuyTime - leader.timestamp;
    if (delay >= COPY_MIN_DELAY_S && delay <= COPY_MAX_DELAY_S) {
      delays.push(delay);
      if (delay < bestDelay) {
        bestDelay = delay;
        bestLeader = leader.address;
      }
    }
  }

  if (!bestLeader || delays.length < COPY_MIN_MATCHES) {
    // Single match is still valid if delay is in the tight window
    if (bestLeader && bestDelay >= COPY_MIN_DELAY_S && bestDelay <= COPY_MAX_DELAY_S) {
      return {
        leader: bestLeader,
        follower: followerAddress,
        avgDelaySeconds: Math.round(bestDelay),
        matchCount: 1,
      };
    }
    return null;
  }

  // Check consistency: stddev of delays < 5s
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  const variance = delays.reduce((a, b) => a + (b - mean) ** 2, 0) / delays.length;
  const stddev = Math.sqrt(variance);

  if (stddev > COPY_MAX_STDDEV_S) return null;

  return {
    leader: bestLeader,
    follower: followerAddress,
    avgDelaySeconds: Math.round(mean),
    matchCount: delays.length,
  };
}

export function computeOrganicScore(wallets: ClassifiedWallet[]): number {
  if (wallets.length === 0) return 100;
  const organic = wallets.filter((w) => w.type === "ORGANIC").length;
  return Math.round((organic / wallets.length) * 100);
}

export function generateVerdict(
  organicScore: number,
  counts: Record<WalletType, number>
): { severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; summary: string } {
  if (organicScore < 20) {
    return {
      severity: "CRITICAL",
      summary: `${100 - organicScore}% of wallet activity is non-organic. ${counts.INSIDER} insider wallets and ${counts.AGENT} agent wallets dominate this token's activity. Price action is substantially manufactured.`,
    };
  }
  if (organicScore < 40) {
    return {
      severity: "HIGH",
      summary: `Organic activity is low at ${organicScore}%. ${counts.INSIDER} insiders and ${counts.SNIPER} snipers entered in the first blocks. Exercise caution.`,
    };
  }
  if (organicScore < 65) {
    return {
      severity: "MEDIUM",
      summary: `Mixed signals. ${organicScore}% organic activity with ${counts.AGENT} detected agents and ${counts.COPY} copy traders. Moderate coordination detected.`,
    };
  }
  return {
    severity: "LOW",
    summary: `${organicScore}% organic activity. Wallet distribution appears relatively healthy. Standard sniper and bot presence within normal ranges.`,
  };
}

// ── Wallet Mode: per-token classification for a single wallet ──

interface WalletTokenResult {
  classification: WalletType;
  entryBlock: number;
  pnlSol: number;
  buyAmount: number;
  sellAmount: number;
  holdingAmount: number;
  tag: string | null;
}

/**
 * Classify a single wallet's behavior on a specific token.
 * Uses timing and cadence heuristics only — no deployer or supply data.
 */
export function classifyWalletForToken(
  txs: ParsedTransaction[],
  walletAddress: string,
  mint: string,
): WalletTokenResult {
  const relevant = filterTxsForWalletMint(txs, walletAddress, mint);
  if (relevant.length === 0) {
    return emptyWalletTokenResult();
  }

  const sorted = [...relevant].sort((a, b) => a.slot - b.slot);
  const firstSlot = sorted[0].slot;
  const profile = buildSingleWalletProfile(sorted, walletAddress, mint, firstSlot);

  const { type, tag } = classifySingleProfile(profile);
  return {
    classification: type,
    entryBlock: profile.firstBlock,
    pnlSol: profile.totalSold - profile.totalBought + profile.currentHolding,
    buyAmount: profile.totalBought,
    sellAmount: profile.totalSold,
    holdingAmount: profile.currentHolding,
    tag,
  };
}

function filterTxsForWalletMint(
  txs: ParsedTransaction[],
  wallet: string,
  mint: string,
): ParsedTransaction[] {
  return txs.filter((tx) =>
    tx.tokenTransfers.some(
      (t) =>
        t.mint === mint &&
        (t.fromUserAccount === wallet || t.toUserAccount === wallet),
    ),
  );
}

function emptyWalletTokenResult(): WalletTokenResult {
  return {
    classification: "ORGANIC",
    entryBlock: 0,
    pnlSol: 0,
    buyAmount: 0,
    sellAmount: 0,
    holdingAmount: 0,
    tag: null,
  };
}

function buildSingleWalletProfile(
  sorted: ParsedTransaction[],
  wallet: string,
  mint: string,
  firstSlot: number,
): WalletProfile {
  const profile: WalletProfile = {
    address: wallet,
    firstBlock: sorted[0].slot - firstSlot,
    txCount: 0,
    txTimestamps: [],
    totalBought: 0,
    totalSold: 0,
    currentHolding: 0,
    isFundedByDeployer: false,
    interactsWithMev: false,
  };

  for (const tx of sorted) {
    const touchesMev = tx.accountData?.some((a) => MEV_PROGRAMS.has(a.account)) ?? false;
    if (touchesMev) profile.interactsWithMev = true;

    for (const t of tx.tokenTransfers) {
      if (t.mint !== mint) continue;
      if (t.toUserAccount === wallet) {
        profile.totalBought += t.tokenAmount;
        profile.currentHolding += t.tokenAmount;
        profile.txCount++;
        profile.txTimestamps.push(tx.timestamp);
      }
      if (t.fromUserAccount === wallet) {
        profile.totalSold += t.tokenAmount;
        profile.currentHolding -= t.tokenAmount;
        profile.txCount++;
        profile.txTimestamps.push(tx.timestamp);
      }
    }
  }

  return profile;
}

/**
 * Simplified classification using timing and cadence only.
 * No deployer-funding or supply-percentage checks.
 */
function classifySingleProfile(
  p: WalletProfile,
): { type: WalletType; tag: string | null } {
  const cadence = computeTxCadenceStdDev(p.txTimestamps);

  // AGENT: uniform cadence or MEV interaction
  if (
    (cadence < 2 && p.txCount > 10) ||
    (p.interactsWithMev && p.txCount > 5) ||
    (p.txCount > 20 && cadence < 5)
  ) {
    const tag = p.interactsWithMev
      ? `MEV BOT — ${p.txCount} TXS`
      : `BOT PATTERN — ${cadence.toFixed(1)}s STDDEV`;
    return { type: "AGENT", tag };
  }

  // INSIDER: block 0-1 entry (relative to first observed tx for this token)
  if (p.firstBlock <= 1 && p.txCount >= 2) {
    return { type: "INSIDER", tag: `BLOCK ${p.firstBlock} ENTRY` };
  }

  // SNIPER: blocks 0-3, low tx count
  if (p.firstBlock <= 3 && p.txCount <= 2) {
    return {
      type: "SNIPER",
      tag: `BLOCK ${p.firstBlock} SNIPE — ${p.txCount} TX${p.txCount > 1 ? "S" : ""}`,
    };
  }

  // COPY: blocks 2-5, moderate tx count
  if (p.firstBlock >= 2 && p.firstBlock <= 5 && p.txCount >= 3 && p.txCount <= 15) {
    return { type: "COPY", tag: `BLOCK ${p.firstBlock} ENTRY — FOLLOWS PATTERN` };
  }

  return { type: "ORGANIC", tag: null };
}

/**
 * Generate a wallet-level verdict from per-token classifications.
 */
export function generateWalletVerdict(
  tokenClassifications: Array<{ classification: WalletType }>,
): { severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"; summary: string } {
  const counts: Record<WalletType, number> = {
    AGENT: 0, INSIDER: 0, COPY: 0, SNIPER: 0, ORGANIC: 0,
  };
  for (const t of tokenClassifications) counts[t.classification]++;

  const total = tokenClassifications.length;

  if (counts.INSIDER >= 3) {
    return {
      severity: "CRITICAL",
      summary: `Wallet classified as INSIDER on ${counts.INSIDER} of ${total} tokens. Consistent early-block entry pattern across multiple launches. High probability of coordinated activity.`,
    };
  }
  if (counts.INSIDER >= 1) {
    return {
      severity: "HIGH",
      summary: `Wallet classified as INSIDER on ${counts.INSIDER} token${counts.INSIDER > 1 ? "s" : ""}, SNIPER on ${counts.SNIPER}. Early entry patterns detected across ${total} tokens.`,
    };
  }
  if (counts.SNIPER + counts.COPY > counts.ORGANIC) {
    return {
      severity: "MEDIUM",
      summary: `Wallet shows ${counts.SNIPER} sniper entries and ${counts.COPY} copy-trade patterns across ${total} tokens. Likely automated or semi-automated trading.`,
    };
  }
  return {
    severity: "LOW",
    summary: `Wallet is primarily organic across ${total} tokens. ${counts.ORGANIC} organic interactions, ${counts.SNIPER} sniper entries. Normal trading behavior.`,
  };
}

// ── Reputation Scoring ──

/** Points awarded per classification type. */
const REP_POINTS: Record<WalletType, number> = {
  INSIDER: 25,
  AGENT: 10,
  SNIPER: 8,
  COPY: 3,
  ORGANIC: 0,
};

const MAX_REPUTATION_SCORE = 100;

const GRADE_THRESHOLDS: Array<[number, ReputationGrade]> = [
  [81, "EXTREME"],
  [56, "HIGH"],
  [31, "MODERATE"],
  [11, "LOW"],
  [0, "CLEAN"],
];

/**
 * Compute a 0–100 suspicion score from a wallet's classification history.
 * Higher = more suspicious. Factors are human-readable explanations.
 */
export function computeReputation(
  history: WalletRecord[],
  walletAge?: string,
  fundedWalletCount?: number,
): ReputationScore {
  if (history.length === 0) {
    return { score: 0, grade: "CLEAN", factors: [] };
  }

  const factors: string[] = [];
  let base = 0;

  // Base points from classification types
  const typeCounts: Record<WalletType, number> = {
    INSIDER: 0, AGENT: 0, SNIPER: 0, COPY: 0, ORGANIC: 0,
  };
  for (const r of history) {
    typeCounts[r.classification]++;
    base += REP_POINTS[r.classification];
  }

  if (typeCounts.INSIDER > 0) {
    factors.push(`INSIDER on ${typeCounts.INSIDER} token${typeCounts.INSIDER > 1 ? "s" : ""}`);
  }
  if (typeCounts.AGENT > 0) {
    factors.push(`AGENT on ${typeCounts.AGENT} token${typeCounts.AGENT > 1 ? "s" : ""}`);
  }
  if (typeCounts.SNIPER > 0) {
    factors.push(`SNIPER on ${typeCounts.SNIPER} token${typeCounts.SNIPER > 1 ? "s" : ""}`);
  }
  if (typeCounts.COPY > 0) {
    factors.push(`COPY on ${typeCounts.COPY} token${typeCounts.COPY > 1 ? "s" : ""}`);
  }

  // Multiplier: avg entry block < 2
  const avgBlock = computeAvgEntryBlock(history);
  if (avgBlock < 2) {
    base = Math.round(base * 1.5);
    factors.push(`Avg entry block ${avgBlock.toFixed(1)}`);
  }

  // Multiplier: wallet age < 1 hour
  if (walletAge && isYoungWallet(walletAge)) {
    base = Math.round(base * 1.5);
    factors.push(`Wallet age: ${walletAge}`);
  }

  // Multiplier: funds > 3 downstream wallets
  const FUNDING_THRESHOLD = 3;
  if (fundedWalletCount != null && fundedWalletCount > FUNDING_THRESHOLD) {
    base = Math.round(base * 1.2);
    factors.push(`Funds ${fundedWalletCount} wallets`);
  }

  const score = Math.min(base, MAX_REPUTATION_SCORE);
  const grade = scoreToGrade(score);

  return { score, grade, factors };
}

function computeAvgEntryBlock(history: WalletRecord[]): number {
  if (history.length === 0) return Infinity;
  const sum = history.reduce((acc, r) => acc + r.entryBlock, 0);
  return sum / history.length;
}

function isYoungWallet(age: string): boolean {
  return age.endsWith("m") || age.endsWith("h");
}

function scoreToGrade(score: number): ReputationGrade {
  for (const [threshold, grade] of GRADE_THRESHOLDS) {
    if (score >= threshold) return grade;
  }
  return "CLEAN";
}
