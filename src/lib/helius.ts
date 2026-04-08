/**
 * Helius API client for Solana transaction data.
 * Uses ONLY mainnet.helius-rpc.com — no api.helius.dev calls.
 * Runs server-side in Cloudflare Functions only.
 */

const HELIUS_RPC = "https://mainnet.helius-rpc.com";
const MAX_TX_PER_PAGE = 100;

/** Normalized transaction shape consumed by classify.ts. */
export interface ParsedTransaction {
  signature: string;
  timestamp: number;
  slot: number;
  type: string;
  source: string;
  feePayer: string;
  nativeTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
    tokenStandard: string;
  }>;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
      userAccount: string;
    }>;
  }>;
}

// ── Helpers ──

function rpcUrl(apiKey: string): string {
  return `${HELIUS_RPC}/?api-key=${apiKey}`;
}

async function rpcCall(
  apiKey: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const res = await fetch(rpcUrl(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = (await res.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result;
}

// ── Token metadata via DAS getAsset ──

export async function getTokenMetadata(
  mint: string,
  apiKey: string,
): Promise<{ name: string; symbol: string }> {
  const result = (await rpcCall(apiKey, "getAsset", { id: mint })) as {
    content?: { metadata?: { name?: string; symbol?: string } };
    token_info?: { symbol?: string };
  };

  const meta = result?.content?.metadata;
  return {
    name: meta?.name?.trim() || "Unknown",
    symbol:
      meta?.symbol?.trim() || result?.token_info?.symbol?.trim() || "???",
  };
}

// ── Wallet origin lookup ──

export interface WalletOrigin {
  firstTxTimestamp: number;
  firstFunder: string | null;
  firstFundAmount: number;
}

/**
 * Get a wallet's first-ever transaction to determine age and initial funder.
 * Single RPC call per wallet (100 credits).
 */
export async function getWalletOrigin(
  address: string,
  apiKey: string,
): Promise<WalletOrigin> {
  const result = (await rpcCall(
    apiKey,
    "getTransactionsForAddress",
    [address, { limit: 1, sortOrder: "asc", encoding: "jsonParsed", transactionDetails: "full" }],
  )) as { data?: Array<RawTxEntryForOrigin> } | null;

  const tx = result?.data?.[0];
  if (!tx) return { firstTxTimestamp: 0, firstFunder: null, firstFundAmount: 0 };

  const timestamp = tx.blockTime ?? 0;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const pre = tx.meta?.preBalances ?? [];
  const post = tx.meta?.postBalances ?? [];

  // Find the first SOL sender to this address
  let firstFunder: string | null = null;
  let firstFundAmount = 0;
  const addrIndex = keys.findIndex((k) => k.pubkey === address);

  if (addrIndex >= 0) {
    const delta = (post[addrIndex] ?? 0) - (pre[addrIndex] ?? 0);
    if (delta > 0) {
      firstFundAmount = delta / LAMPORTS_PER_SOL_CONST;
      // Funder is the signer who lost SOL
      for (let i = 0; i < keys.length; i++) {
        if (i === addrIndex) continue;
        const loss = (pre[i] ?? 0) - (post[i] ?? 0);
        if (loss > 0 && keys[i].signer) {
          firstFunder = keys[i].pubkey;
          break;
        }
      }
    }
  }

  return { firstTxTimestamp: timestamp, firstFunder, firstFundAmount };
}

/** Lightweight type for origin lookup — only needs keys and balances. */
interface RawTxEntryForOrigin {
  blockTime: number | null;
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean }>;
    };
  };
  meta: {
    preBalances: number[];
    postBalances: number[];
  } | null;
}

const LAMPORTS_PER_SOL_CONST = 1_000_000_000;
const ORIGIN_BATCH_SIZE = 10;

/**
 * Batch lookup wallet origins for multiple addresses.
 * Returns results for all addresses, with fallbacks for failures.
 */
export async function getWalletOriginBatch(
  addresses: string[],
  apiKey: string,
): Promise<Map<string, WalletOrigin>> {
  const results = new Map<string, WalletOrigin>();

  for (let i = 0; i < addresses.length; i += ORIGIN_BATCH_SIZE) {
    const batch = addresses.slice(i, i + ORIGIN_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((addr) => getWalletOrigin(addr, apiKey)),
    );

    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      results.set(
        batch[j],
        outcome.status === "fulfilled"
          ? outcome.value
          : { firstTxTimestamp: 0, firstFunder: null, firstFundAmount: 0 },
      );
    }
  }

  return results;
}

const METADATA_BATCH_SIZE = 10;

/**
 * Fetch token metadata for multiple mints in parallel batches.
 * Failed lookups get fallback values instead of throwing.
 */
export async function getTokenMetadataBatch(
  mints: string[],
  apiKey: string,
): Promise<Map<string, { name: string; symbol: string }>> {
  const results = new Map<string, { name: string; symbol: string }>();

  for (let i = 0; i < mints.length; i += METADATA_BATCH_SIZE) {
    const batch = mints.slice(i, i + METADATA_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map((mint) => getTokenMetadata(mint, apiKey)),
    );

    for (let j = 0; j < settled.length; j++) {
      const outcome = settled[j];
      const mint = batch[j];
      results.set(
        mint,
        outcome.status === "fulfilled"
          ? outcome.value
          : { name: "Unknown", symbol: mint.slice(0, 6) },
      );
    }
  }

  return results;
}

// ── Raw RPC types ──

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner: string;
  programId: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

interface RawAccountKey {
  pubkey: string;
  writable: boolean;
  signer: boolean;
  source: string;
}

interface RawTxEntry {
  transaction: {
    signatures: string[];
    message: { accountKeys: RawAccountKey[] };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: RawTokenBalance[];
    postTokenBalances: RawTokenBalance[];
  } | null;
  slot: number;
  blockTime: number | null;
}

interface PagedResult {
  data: RawTxEntry[];
  paginationToken?: string;
}

// ── Fetch transactions (single call per page, replaces sig+parse N+1) ──

/**
 * Fetch up to `maxTx` full parsed transactions for a token mint using
 * the Helius-exclusive getTransactionsForAddress method.
 * One RPC call returns up to 100 full transactions — eliminates
 * the old getSignatures + parseTransactions N+1 pattern.
 */
export async function getTransactionsForToken(
  mint: string,
  apiKey: string,
  maxTx = 500,
): Promise<ParsedTransaction[]> {
  const results: ParsedTransaction[] = [];
  let cursor: string | undefined;

  while (results.length < maxTx) {
    const limit = Math.min(MAX_TX_PER_PAGE, maxTx - results.length);

    const params: Record<string, unknown> = {
      limit,
      sortOrder: "asc",
      commitment: "confirmed",
      encoding: "jsonParsed",
      transactionDetails: "full",
    };
    if (cursor) params.paginationToken = cursor;

    const page = (await rpcCall(
      apiKey,
      "getTransactionsForAddress",
      [mint, params],
    )) as PagedResult;

    if (!page?.data?.length) break;

    for (const entry of page.data) {
      const normalized = normalizeTransaction(entry);
      if (normalized) results.push(normalized);
    }

    cursor = page.paginationToken;
    if (!cursor) break;
  }

  return results;
}

// ── Normalize raw RPC → ParsedTransaction ──

function normalizeTransaction(raw: RawTxEntry): ParsedTransaction | null {
  if (!raw.meta) return null;

  const keys = raw.transaction.message.accountKeys;
  const signature = raw.transaction.signatures[0] ?? "";
  const feePayer =
    keys.find((k) => k.signer)?.pubkey ?? keys[0]?.pubkey ?? "";

  const ownerByIndex = new Map<number, string>();
  for (let i = 0; i < keys.length; i++) {
    ownerByIndex.set(i, keys[i].pubkey);
  }

  return {
    signature,
    timestamp: raw.blockTime ?? 0,
    slot: raw.slot,
    type: "UNKNOWN",
    source: "RPC",
    feePayer,
    nativeTransfers: deriveNativeTransfers(
      raw.meta.preBalances,
      raw.meta.postBalances,
      ownerByIndex,
    ),
    tokenTransfers: deriveTokenTransfers(
      raw.meta.preTokenBalances,
      raw.meta.postTokenBalances,
    ),
    accountData: keys.map((key, idx) => ({
      account: key.pubkey,
      nativeBalanceChange:
        (raw.meta!.postBalances[idx] ?? 0) -
        (raw.meta!.preBalances[idx] ?? 0),
      tokenBalanceChanges: [],
    })),
  };
}

// ── Token transfers: diff pre vs post balances per (owner, mint) ──

function deriveTokenTransfers(
  pre: RawTokenBalance[],
  post: RawTokenBalance[],
): ParsedTransaction["tokenTransfers"] {
  type Entry = {
    owner: string;
    mint: string;
    pre: bigint;
    post: bigint;
    decimals: number;
  };
  const balances = new Map<string, Entry>();

  for (const b of pre) {
    const key = `${b.owner}:${b.mint}`;
    balances.set(key, {
      owner: b.owner,
      mint: b.mint,
      pre: BigInt(b.uiTokenAmount.amount),
      post: 0n,
      decimals: b.uiTokenAmount.decimals,
    });
  }

  for (const b of post) {
    const key = `${b.owner}:${b.mint}`;
    const existing = balances.get(key);
    if (existing) {
      existing.post = BigInt(b.uiTokenAmount.amount);
    } else {
      balances.set(key, {
        owner: b.owner,
        mint: b.mint,
        pre: 0n,
        post: BigInt(b.uiTokenAmount.amount),
        decimals: b.uiTokenAmount.decimals,
      });
    }
  }

  const transfers: ParsedTransaction["tokenTransfers"] = [];

  for (const e of balances.values()) {
    const delta = e.post - e.pre;
    if (delta === 0n) continue;

    const absAmount =
      Number(delta < 0n ? -delta : delta) / 10 ** e.decimals;

    transfers.push(
      delta > 0n
        ? {
            fromUserAccount: "",
            toUserAccount: e.owner,
            mint: e.mint,
            tokenAmount: absAmount,
            tokenStandard: "Fungible",
          }
        : {
            fromUserAccount: e.owner,
            toUserAccount: "",
            mint: e.mint,
            tokenAmount: absAmount,
            tokenStandard: "Fungible",
          },
    );
  }

  return transfers;
}

// ── Native SOL transfers: diff lamport balances ──

function deriveNativeTransfers(
  preBalances: number[],
  postBalances: number[],
  ownerByIndex: Map<number, string>,
): ParsedTransaction["nativeTransfers"] {
  const LAMPORTS_PER_SOL = 1_000_000_000;
  const MIN_SOL = 0.001;

  const senders: Array<{ addr: string; amount: number }> = [];
  const receivers: Array<{ addr: string; amount: number }> = [];

  for (let i = 0; i < preBalances.length; i++) {
    const delta = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
    const addr = ownerByIndex.get(i);
    if (!addr) continue;

    const sol = delta / LAMPORTS_PER_SOL;
    if (sol < -MIN_SOL) senders.push({ addr, amount: -delta });
    else if (sol > MIN_SOL) receivers.push({ addr, amount: delta });
  }

  const transfers: ParsedTransaction["nativeTransfers"] = [];
  const primarySender = senders.sort((a, b) => b.amount - a.amount)[0];
  if (!primarySender) return transfers;

  for (const r of receivers) {
    transfers.push({
      fromUserAccount: primarySender.addr,
      toUserAccount: r.addr,
      amount: r.amount,
    });
  }

  return transfers;
}
