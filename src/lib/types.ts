export type WalletType = "AGENT" | "INSIDER" | "COPY" | "SNIPER" | "ORGANIC";

export interface PriorRecord {
  tokenSymbol: string;
  classification: WalletType;
  timestamp: string;
}

export type ReputationGrade = "CLEAN" | "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export interface ReputationScore {
  /** 0–100, higher = more suspicious. */
  score: number;
  grade: ReputationGrade;
  /** Human-readable factors that contributed to the score. */
  factors: string[];
}

export interface ClassifiedWallet {
  address: string;
  type: WalletType;
  pnlSol: number;
  pnlUsd: number;
  supplyPercent: number;
  entryBlock: number;
  txCount: number;
  tag: string | null;
  priorHistory?: PriorRecord[];
  walletAge?: string;
  firstFunder?: string;
  firstFundAmountSol?: number;
  reputation?: ReputationScore;
}

/** KV value shape stored per wallet address. */
export interface WalletRecord {
  tokenMint: string;
  tokenSymbol: string;
  classification: WalletType;
  entryBlock: number;
  timestamp: string;
}

export interface ScanResult {
  token: {
    name: string;
    symbol: string;
    mint: string;
    age: string;
    mcap: number;
    volume24h: number;
    totalHolders: number;
    deployerAddress: string;
  };
  organicScore: number;
  counts: Record<WalletType, number>;
  wallets: ClassifiedWallet[];
  copyNetwork?: CopyRelationship[];
  verdict: {
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    summary: string;
  };
}

// ── Copy Trade Network ──

export interface CopyRelationship {
  /** Wallet address being copied (INSIDER or AGENT). */
  leader: string;
  /** The copy wallet following the leader. */
  follower: string;
  /** Average delay in seconds between leader and follower buys. */
  avgDelaySeconds: number;
  /** How many tokens they co-traded with this timing pattern. */
  matchCount: number;
}

export type ThreatType = "RUG" | "HONEYPOT" | "BUNDLE" | "AGENT_EXPLOIT" | "WHALE_SELL" | "INSIDER_MOVE" | "LARGE_BUY" | "LP_CHANGE";
export type ThreatSeverity = "CRITICAL" | "HIGH" | "MEDIUM";

export interface ThreatEvent {
  id: string;
  timestamp: string;
  type: ThreatType;
  severity: ThreatSeverity;
  tokenSymbol: string;
  tokenMint: string;
  detail: string;
  /** SOL value of LP removed (for RUG events). */
  lpRemovedSol?: number;
  /** Percentage of LP removed in a single transaction. */
  lpRemovedPct?: number;
  /** Address that initiated the LP removal. */
  removerAddress?: string;
  /** Wallet that triggered the alert (whale alerts). */
  wallet?: string;
  /** Classification of the wallet, if known. */
  walletType?: WalletType | null;
  /** SOL amount involved in the alert transaction. */
  amountSol?: number;
}

/** KV shape for a watched token. */
export interface WatchedToken {
  mint: string;
  symbol: string;
  addedAt: string;
  webhookId: string | null;
}

// ── Rug Replay ──

export type TimelineEventType =
  | "CREATION"
  | "INSIDER_BUY"
  | "BOT_ENTRY"
  | "SNIPER_ENTRY"
  | "ORGANIC_BUY"
  | "LARGE_SELL"
  | "LP_REMOVE"
  | "MASS_DUMP";

export type RugMethod = "LP_PULL" | "MASS_DUMP" | "SELL_TAX" | "UNKNOWN";

export interface TimelineEvent {
  /** Unix seconds. */
  timestamp: number;
  /** Human-readable offset from token creation: "+0s", "+4m 12s". */
  relativeTime: string;
  type: TimelineEventType;
  wallet: string;
  walletType: WalletType;
  /** Human-readable description. */
  detail: string;
  amountSol?: number;
  supplyPercent?: number;
}

export interface ReplayResult {
  token: {
    name: string;
    symbol: string;
    mint: string;
    createdAt: number;
  };
  timeline: TimelineEvent[];
  summary: {
    lifespan: string;
    peakHolders: number;
    organicLossEstimate: number;
    insiderProfitEstimate: number;
    rugMethod: RugMethod;
  };
  walletBreakdown: Record<WalletType, number>;
}

// ── Leaderboard ──

export interface LeaderboardEntry {
  address: string;
  /** How many tokens this wallet was flagged on. */
  appearances: number;
  /** 0–100 win rate (pnl > 0). */
  winRate: number;
  avgEntryBlock: number;
  totalEstimatedPnlSol: number;
  /** ISO timestamp of most recent classification. */
  lastSeen: string;
}

export interface LeaderboardResult {
  type: WalletType;
  entries: LeaderboardEntry[];
  totalWalletsTracked: number;
  /** Human-readable data span, e.g. "last 30 days". */
  dataSpan: string;
}

// ── Wallet Mode ──

export interface FundingEntry {
  address: string;
  amountSol: number;
  timestamp: string;
}

export interface WalletTokenEntry {
  mint: string;
  symbol: string;
  name: string;
  classification: WalletType;
  entryBlock: number;
  pnlSol: number;
  buyAmount: number;
  sellAmount: number;
  holdingAmount: number;
  firstTx: string;
  tag: string | null;
}

export interface WalletScanResult {
  wallet: {
    address: string;
    totalPnlSol: number;
    totalTokensTouched: number;
    winRate: number;
    firstActivity: string;
    fundedBy: string[];
    fundedAddresses: string[];
    priorHistory?: PriorRecord[];
    walletAge?: string;
    firstFunder?: string;
    firstFundAmountSol?: number;
    reputation?: ReputationScore;
  };
  tokens: WalletTokenEntry[];
  associations: {
    fundingSources: FundingEntry[];
    fundedWallets: FundingEntry[];
  };
  verdict: {
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    summary: string;
  };
}
