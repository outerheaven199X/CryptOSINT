# CryptOSINT

Crypto entity classification dashboard. Paste a token address, see every wallet classified: agents, insiders, copy traders, snipers, organic humans. One "organic score" tells you how real the token's activity is.

## Stack
- Vite + React + TypeScript
- Tailwind CSS (utility only, no component library)
- Cloudflare Pages (frontend) + Cloudflare Functions (API proxy)
- Helius API for Solana transaction data
- No database, no auth, fully stateless

## Architecture

```
src/
  components/     # React UI components
  lib/
    classify.ts   # Wallet classification heuristics
    helius.ts     # Helius API client
    types.ts      # Shared types
  api/
    scan.ts       # Core scan orchestration
functions/
  api/
    scan.ts       # Cloudflare Function — proxies Helius, runs classification
public/
```

### Data Flow
1. User pastes token mint address in frontend
2. Frontend POSTs to `/api/scan` with `{ mint: string }`
3. Cloudflare Function receives request
4. Function calls Helius `getSignaturesForAsset` and `parseTransactions` for the token
5. Function runs classification logic on the wallet set
6. Function returns `ScanResult` JSON to frontend
7. Frontend renders results

### Helius API Calls Needed
- `POST https://mainnet.helius-rpc.com/?api-key=KEY` with `getSignaturesForAddress` (token mint) to get transaction signatures
- `POST https://api.helius.dev/v0/transactions?api-key=KEY` with signature list to get parsed transaction data
- From parsed transactions, extract: all wallets that interacted, buy/sell actions, timestamps, block numbers, amounts

### Environment
- `HELIUS_API_KEY` — set in Cloudflare dashboard as a secret, accessed via `env.HELIUS_API_KEY` in Functions

## Classification Logic (lib/classify.ts)

Each wallet gets classified into one of five types based on behavioral heuristics:

### INSIDER
- Bought in block 0-1 of the token's existence
- Funding path connects to deployer wallet (check if deployer funded this wallet in the last 24h)
- Holds >1% of supply

### AGENT (AI/Bot)
- Transaction cadence is uniform (stddev of time between txs < 2 seconds)
- High tx count relative to token age (>20 txs in first hour)
- Interacts with known MEV/Jito bundle programs
- No NFTs, no DeFi positions, no SOL staking — pure token trading wallet
- Gas optimization patterns: always uses exact compute units

### SNIPER
- Bought in blocks 1-3
- Wallet has minimal prior transaction history (<10 lifetime txs)
- Single buy transaction, no sells yet OR immediate sell within minutes

### COPY
- Buys the same token within 3-30 seconds after an INSIDER wallet
- Pattern repeats across multiple tokens (if we can check — may need caching)
- Consistent delay signature (always ~5s behind the same leader)

### ORGANIC
- Default classification if none of the above patterns match
- Bought after block 10+
- Normal transaction cadence
- Has diverse wallet history

### Organic Score
`organic_score = (organic_wallet_count / total_wallet_count) * 100`
Weighted version (stretch): weight by volume so a whale insider counts more than a dust wallet.

## Threat Feed (Phase 2)
The /threats view monitors for:
- LP removal events on recently created tokens
- Sell tax escalation (honeypot activation)
- Coordinated dump patterns from classified insider wallets
- Agent wallet exploit signatures (unusual MCP-related program interactions)

For v0.1, this can be mock data. Real feed requires a polling worker.

## Design Spec

### Fonts
- Display/Headlines: Space Grotesk 700 — used for hero text, token names, stat values
- Mono/Labels: IBM Plex Mono 400/500/600 — used for addresses, tags, metadata, input fields
- Load from Google Fonts

### Colors
```
bg:          #07080a
surface:     #0c0e12
surfaceHov:  #11141a
border:      rgba(255,255,255,0.06)
borderHov:   rgba(255,255,255,0.12)
text:        #e8e8e8
textDim:     rgba(255,255,255,0.4)
textGhost:   rgba(255,255,255,0.15)
green:       #00e87b   (organic, positive, active states)
red:         #ff3b5c   (insider, negative, critical)
amber:       #FFB800   (copy traders, warnings)
cyan:        #00BFFF   (agents)
purple:      #7B61FF   (snipers)
```

### Typography Scale (IMPORTANT: text should feel big and confident)
- Hero headline: clamp(56px, 9vw, 96px), weight 700, tracking -0.04em
- Section stat values: 48px large, 28px standard
- Body/table text: 14px
- Labels/tags: 11px
- Micro labels: 10px

### Principles
- NO scanlines, no noise overlay, no CRT effects
- Dark-first, no light mode
- Subtle only: opacity transitions, border highlights on hover, staggered row reveals
- Screenshot-friendly: the verdict panel and organic score should look good as a cropped image
- Desktop-first but responsive

### Key UI Pieces
1. Top bar: "CryptOSINT" wordmark left, SCAN/THREATS nav center-ish, status indicator right
2. Hero: "See who's really in it." with typing animation on first load only
3. Input: token mint input with SCAN button, scan progress bar with phase labels
4. Results: organic score (huge hero number), stat cards grid, composition bar, wallet table, verdict panel
5. Threats: live feed of agent-driven attacks/rugs with severity indicators

## Commands
```bash
npm install
npm run dev          # local dev server
npm run build        # production build
npx wrangler pages deploy dist  # deploy to Cloudflare Pages
```

## What NOT to do
- Don't add authentication or wallet connection. This is a public tool.
- Don't use any UI component library (no shadcn, no MUI, no Chakra). Hand-styled only.
- Don't add a database. Every scan is stateless against the Helius API.
- Don't overthink the classification. The heuristics should be fast and plausible, not academically rigorous. If a wallet bought in block 1 and has deployer funding, it's an insider. Done.
- Don't add light mode.
