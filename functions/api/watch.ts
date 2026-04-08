/**
 * Cloudflare Pages Function: POST /api/watch + GET /api/watch?mint=X
 *
 * POST: Add or remove a token from the watch list.
 *   Body: { mint: string, symbol?: string, action: "add" | "remove" }
 *   Creates a Helius webhook for the mint on "add", deletes on "remove".
 *
 * GET: Check if a token is being watched.
 *   Query: ?mint=X
 *   Returns: { watched: boolean }
 */

import type { WatchedToken } from "../../src/lib/types";

interface Env {
  HELIUS_API_KEY: string;
  SKNWLKR_CACHE: KVNamespace;
  /** Public URL for webhook callbacks. Set in Cloudflare dashboard. */
  WEBHOOK_BASE_URL?: string;
}

const WATCH_KV_PREFIX = "watch:";
const WATCH_TTL_SECONDS = 30 * 24 * 60 * 60;
const HELIUS_WEBHOOK_URL = "https://api.helius.dev/v0/webhooks";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

// ── GET: check watch status ──

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const url = new URL(context.request.url);
    const mint = url.searchParams.get("mint")?.trim();

    if (!mint) {
      return jsonError("Missing mint parameter", 400);
    }

    const existing = await context.env.SKNWLKR_CACHE.get(
      `${WATCH_KV_PREFIX}${mint}`,
      "json",
    ) as WatchedToken | null;

    return jsonOk({ watched: existing !== null, token: existing });
  } catch (err: unknown) {
    return jsonError(errMsg(err), 500);
  }
};

// ── POST: add or remove watch ──

export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body = (await context.request.json()) as {
      mint: string;
      symbol?: string;
      action: "add" | "remove";
    };

    const mint = body.mint?.trim();
    const action = body.action;

    if (!mint || mint.length < 32) {
      return jsonError("Invalid mint address", 400);
    }
    if (action !== "add" && action !== "remove") {
      return jsonError("action must be 'add' or 'remove'", 400);
    }

    const kv = context.env.SKNWLKR_CACHE;
    const apiKey = context.env.HELIUS_API_KEY;
    const kvKey = `${WATCH_KV_PREFIX}${mint}`;

    if (action === "remove") {
      const existing = await kv.get(kvKey, "json") as WatchedToken | null;
      if (existing?.webhookId && apiKey) {
        await deleteHeliusWebhook(existing.webhookId, apiKey).catch(() => {
          /* best-effort cleanup */
        });
      }
      await kv.delete(kvKey);
      return jsonOk({ watched: false });
    }

    // action === "add"
    const existing = await kv.get(kvKey, "json") as WatchedToken | null;
    if (existing) {
      return jsonOk({ watched: true, token: existing });
    }

    // Create Helius webhook
    let webhookId: string | null = null;
    const webhookBaseUrl = context.env.WEBHOOK_BASE_URL;
    if (apiKey && webhookBaseUrl) {
      webhookId = await createHeliusWebhook(
        mint, webhookBaseUrl, apiKey,
      );
    }

    const token: WatchedToken = {
      mint,
      symbol: body.symbol ?? mint.slice(0, 6),
      addedAt: new Date().toISOString(),
      webhookId,
    };

    await kv.put(kvKey, JSON.stringify(token), {
      expirationTtl: WATCH_TTL_SECONDS,
    });

    return jsonOk({ watched: true, token });
  } catch (err: unknown) {
    return jsonError(errMsg(err), 500);
  }
};

export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
};

// ── Helius webhook helpers ──

async function createHeliusWebhook(
  mint: string,
  baseUrl: string,
  apiKey: string,
): Promise<string | null> {
  const callbackUrl = `${baseUrl}/api/webhook`;

  const res = await fetch(`${HELIUS_WEBHOOK_URL}?api-key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      webhookURL: callbackUrl,
      transactionTypes: ["TRANSFER"],
      accountAddresses: [mint],
      webhookType: "enhanced",
    }),
  });

  if (!res.ok) {
    console.error("Helius webhook creation failed:", await res.text());
    return null;
  }

  const data = (await res.json()) as { webhookID?: string };
  return data.webhookID ?? null;
}

async function deleteHeliusWebhook(
  webhookId: string,
  apiKey: string,
): Promise<void> {
  await fetch(`${HELIUS_WEBHOOK_URL}/${webhookId}?api-key=${apiKey}`, {
    method: "DELETE",
  });
}

// ── Utilities ──

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200, headers: CORS_HEADERS,
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: CORS_HEADERS,
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "Internal server error";
}
