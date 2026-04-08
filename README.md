# CryptOSINT

Paste a Solana token address. CryptOSINT pulls the transaction history and classifies every wallet that touched it: insiders, bots, snipers, copy traders, and the actual humans.

One number at the top tells you the organic score. The percentage of activity coming from real participants. The table below tells you everything else.

## Classification types

**INSIDER** — Bought in block 0 or 1, funded by the deployer, holds a large chunk of supply. These wallets existed before you knew the token did.

**AGENT** — AI trading bots and MEV bots. Detected by uniform transaction intervals (1-2 second cadence, no human trades like that) and interaction with Jito bundle programs.

**SNIPER** — Entered blocks 0-3 with almost no prior transaction history. Wallet was created to buy this token and nothing else.

**COPY** — Follows an insider's buys with a consistent delay, usually 3-30 seconds behind. Same tokens, same timing, different wallet.

**ORGANIC** — None of the above patterns matched. Probably a person.

## Tools

**Token Scan** — The core feature. Paste a mint address, get the organic score, classification breakdown, and a wallet-by-wallet table with PNL, supply percentage, entry block, and behavioral signature.

**Wallet Scan** — Works the other direction. Paste a wallet address and see every token it touched, what it was classified as on each one, its total PNL, win rate, and who funded it. Clicking any wallet address in a token scan automatically runs a wallet scan on it.

**Rug Replay** — For tokens that already died. Reconstructs the full timeline as a vertical sequence: when insiders bought, when bots started generating volume, when organic holders arrived, and when the LP got pulled. A post-mortem you can scroll through.

**LP Monitor** — Runs as part of every token scan. Shows which DEX the pool is on, initial vs current liquidity, and whether the LP tokens are burned. If the deployer still holds them (meaning they can drain the pool whenever they want), it says so in red.

**Copy Trade Network** — Maps who is copying who. Leader wallet on the left, followers branching right, with the delay in seconds between them. Some insiders have 10+ copy bots tailing them across dozens of tokens.

**Sniper Leaderboard** — Aggregated from all scans stored in the cache. Ranks sniper wallets by how many tokens they've hit, their win rate, and average entry block. Updated as new scans come in.

**Whale Alerts** — Click "Watch" on any scanned token. When a classified wallet makes a significant move on that token, it shows up in the threat feed. Powered by Helius webhooks pushing to a Cloudflare Worker.

**Wallet Reputation** — A 0-100 suspicion score built from the full history of a wallet's classifications across every scan in the cache. Factors in how many times it's been flagged as INSIDER, average hold time, and how many downstream wallets it funds. The score appears next to every wallet address in the UI.

**Threat Feed** — Running stream of detected rugs, honeypots, coordinated bundle buys, and agent exploits across watched tokens.

**Export** — Any scan result downloads as structured JSON. For feeding into your own tools or sending to exchanges.

## Stack

Vite, React, TypeScript on the frontend. Cloudflare Pages serves the app, Cloudflare Functions handle the API layer. Helius provides Solana transaction data through `getTransactionsForAddress` (their enhanced RPC method that returns full parsed transactions in a single call) and the DAS `getAsset` method for token metadata. Cloudflare KV stores the cross-token wallet classification cache that powers the reputation scores and leaderboard. Helius webhooks handle real-time alerts.

## Running it

```bash
git clone https://github.com/outerheaven199x/cryptosint
cd cryptosint
npm install
cp .dev.vars.example .dev.vars  # add your Helius API key
npm run dev                      # frontend on :5173
npx wrangler pages dev dist      # API on :8788
```

You need a Helius API key on the Developer plan or higher for `getTransactionsForAddress` access.

## How it works

The frontend calls Cloudflare Functions at `/api/scan`, `/api/wallet`, `/api/replay`, `/api/leaderboard`, `/api/threats`, and `/api/watch`. Each function proxies Helius, runs classification server-side, caches wallet results in KV, and returns JSON. No database. No auth. Stateless against the chain.

The classification engine is in `src/lib/classify.ts`. The heuristics are opinionated. A wallet that bought in block 0 with deployer funding gets tagged INSIDER without further analysis. A wallet with 1-second transaction cadence interacting with Jito gets tagged AGENT. The point is speed over nuance, because the person using this is deciding whether to ape in the next 30 seconds, not writing a research paper.

## Why this exists

A fresh pump.fun token launches. Within seconds, the deployer's insiders have already bought. Bots are generating fake volume. Snipers grabbed their positions in block 0. Copy bots are tailing the insiders with 4-second delays. By the time an organic buyer shows up, the token is 86% non-organic and the chart looks bullish because of manufactured activity.

That buyer has no way to see any of this from a block explorer or a chart. CryptOSINT shows them the player map.

## Links

GitHub: [github.com/outerheaven199x/cryptosint](https://github.com/outerheaven199x/cryptosint)
X: [@varien](https://x.com/varien)
