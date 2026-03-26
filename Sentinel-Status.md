# Sentinel — Project Status

**Last Updated:** March 25, 2026 (Phase 3 complete — all 5 endpoints live)

---

## Overview

Sentinel is an x402-gated trust verification service for autonomous AI agents. Agents pay micro-fees in USDC on Base to get real-time trust assessments of smart contracts, tokens, and DeFi positions before interacting with them.

---

## Current State: Deployed to Production

**Live URL:** https://sentinel-awms.onrender.com

The server is deployed on Render with a working x402 payment wall and live data integrations. Three paid endpoints are live: `/verify/protocol`, `/verify/token`, and `/verify/position`. All endpoints support a `detail` query parameter to control how much scoring methodology is exposed in responses. Dev test routes are active (base-sepolia mode) and will auto-disable when switched to mainnet.

---

## Architecture

- **Runtime:** Node.js / Express (ESM)
- **Payment:** @x402/express v2 — `paymentMiddlewareFromConfig` global middleware
- **Network:** Base Sepolia (`eip155:84532`) for testnet, Base Mainnet (`eip155:8453`) for prod
- **Facilitator:** `https://x402.org/facilitator` (testnet)
- **Port:** 4021

## Live Data Sources

| Source | What It Provides | Auth Required | Status |
|--------|-----------------|---------------|--------|
| DeFiLlama `/protocols` | TVL data, hack flags, protocol registry (2,845 addresses indexed from 7,235 protocols) | No | Working |
| GoPlus Security API (`api.gopluslabs.io`) | Honeypot detection, contract blacklist, token security (tax, ownership, holder data) | Yes (free key + secret) | Working |
| Etherscan V2 API (`api.etherscan.io/v2/api`) | Contract source verification, proxy detection, deployment date | Yes (free key) | Working |
| Alchemy | Bytecode existence checks (is it a contract?) | Yes (free key) | Working |

## Scoring Engines

### Protocol Trust Score (6 dimensions)

| Dimension | Weight | Data Source |
|-----------|--------|-------------|
| Audit status | 25% | Curated list + DeFiLlama registry |
| Exploit history | 25% | DeFiLlama hack flags + GoPlusLabs |
| Contract maturity | 15% | Basescan deployment date |
| TVL stability | 15% | DeFiLlama live TVL |
| Governance transparency | 10% | Protocol metadata |
| Community trust | 10% | Protocol metadata |

### Token Safety Score (5 dimensions)

| Dimension | Weight | Data Source |
|-----------|--------|-------------|
| Honeypot & scam detection | 30% | GoPlusLabs honeypot + airdrop scam flags |
| Tax fairness | 20% | GoPlusLabs buy/sell tax + slippage modification |
| Ownership & control risk | 25% | GoPlusLabs ownership, mintability, pausability |
| Liquidity & holder distribution | 15% | GoPlusLabs holder count + DeFiLlama TVL |
| Trading freedom | 10% | GoPlusLabs cooldown, blacklist, whitelist |

### Position Risk Score (4 dimensions)

| Dimension | Weight | Data Source |
|-----------|--------|-------------|
| Protocol foundation | 40% | Derived from protocol trust score |
| Category risk | 20% | DeFiLlama category (14 risk tiers) |
| TVL health | 20% | DeFiLlama live TVL + 30d trend |
| Concentration risk | 20% | Structural assessment from TVL depth |

### Counterparty Risk Score (4 dimensions)

| Dimension | Weight | Data Source |
|-----------|--------|-------------|
| Sanctions screening | 40% | OFAC SDN list (87 ETH addresses, daily-updated from GitHub) |
| Address reputation | 30% | GoPlus address security API (malicious, phishing, cybercrime, mixer) |
| Exploit association | 20% | DeFiLlama protocol registry (hacked flag) |
| Address type | 10% | GoPlus (contract vs. EOA classification) |

### Preflight Composite Score (dynamic weighting)

| Component | Weight | Source |
|-----------|--------|--------|
| Protocol trust | 35% | `/verify/protocol` scoring engine |
| Position risk | 25% | `/verify/position` scoring engine |
| Token safety | 20% | `/verify/token` scoring engine (if token provided) |
| Counterparty risk | 20% | `/verify/counterparty` scoring engine (if counterparty provided) |

*Weights normalize to 100% based on which checks run. Hard blockers (OFAC sanctions, honeypots) override to DANGER/F regardless of composite.*

Grades: A (85+) / B (70-84) / C (55-69) / D (40-54) / F (0-39)
Verdicts: SAFE / LOW_RISK / CAUTION / HIGH_RISK / DANGER

---

## Endpoints

| Endpoint | Price | Status | Description |
|----------|-------|--------|-------------|
| `GET /verify/protocol?address=0x...` | $0.008 | Live | Full protocol trust assessment |
| `GET /verify/token?address=0x...` | $0.005 | Live | Token safety: honeypot, tax, ownership, holders |
| `GET /verify/position?protocol=0x...` | $0.005 | Live | Position risk: protocol trust + category + TVL + concentration |
| `GET /verify/counterparty` | $0.01 | Live | OFAC sanctions screening, address reputation, exploit association |
| `GET /preflight` | $0.025 | Live | Unified pre-transaction check (protocol + token + counterparty + position) |
| `GET /health` | Free | Live | Server status + endpoint catalog |

### Response Detail Levels

All paid endpoints accept a `?detail=` parameter:

| Level | What's Returned | Use Case |
|-------|----------------|----------|
| `full` (default) | Verdict, grade, score, all dimensions, evidence, risk flags | Debugging, internal testing |
| `standard` | Verdict, grade, evidence, risk flags (no dimension scores) | Production — hides scoring weights |
| `minimal` | Verdict, grade, confidence only | Maximum IP protection |

---

## Environment Variables

| Key | Purpose | Status |
|-----|---------|--------|
| `WALLET_ADDRESS` | USDC receiving wallet on Base | Configured |
| `NETWORK` | `base-sepolia` or `base` | Set to `base-sepolia` |
| `FACILITATOR_URL` | x402 facilitator endpoint | Configured |
| `ALCHEMY_API_KEY` | Bytecode checks | Configured |
| `BASESCAN_API_KEY` | Etherscan V2 — contract verification + age | Configured |
| `GOPLUS_API_KEY` | GoPlus Security — token/contract security data | Configured |
| `GOPLUS_API_SECRET` | GoPlus Security secret | Configured |
| `CDP_API_KEY_ID` | Coinbase Developer Platform | Configured |
| `CDP_API_KEY_SECRET` | CDP secret | Configured |
| `PORT` | Server port | 4021 |

---

## Files in This Folder

| File | Purpose |
|------|---------|
| `server.js` | Main application — all endpoints, data layer, 3 scoring engines, response filtering |
| `package.json` | Dependencies: @x402/core, @x402/evm, @x402/express, axios, dotenv, express |
| `.env` | Local secrets (not committed) |
| `.env.example` | Template for environment setup |
| `README.md` | Project overview |
| `Sentinel-TermsOfService.docx` | Legal — 14 sections, Ohio jurisdiction, AAA arbitration |
| `Sentinel-BazaarListing.md` | Service listing for Bazaar discovery |
| `Sentinel-ProjectTimeline.xlsx` | 30 tasks, 4 phases, milestones, cost breakdown |
| `Sentinel-ResearchNotes.md` | x402 protocol reference, data sources, competitive landscape |
| `Sentinel-Status.md` | This file |

---

## What's Done

- [x] Project documentation (ToS, Bazaar listing, timeline, research notes)
- [x] Coinbase Developer Platform account + API keys
- [x] Alchemy account + API key
- [x] Dedicated Sentinel wallet created
- [x] `.env` configured with all core keys
- [x] Server code migrated to @x402/express v2 API (`paymentMiddlewareFromConfig`)
- [x] ExactEvmScheme registered for both Base Sepolia and Base Mainnet
- [x] DeFiLlama protocol registry integration (2,845 addresses on startup)
- [x] GoPlus Security API integration with auth (protocol + token security) — domain migrated to `api.gopluslabs.io`
- [x] Etherscan V2 API integration (contract verification + age) — migrated from legacy Basescan endpoints
- [x] All API keys configured and tested: Alchemy, Etherscan V2, GoPlus, CDP
- [x] `/verify/protocol` — 6-dimension trust scoring engine
- [x] `/verify/token` — 5-dimension token safety scoring (honeypot, tax, ownership, liquidity, trading)
- [x] `/verify/position` — 4-dimension position risk analysis (protocol trust, category, TVL, concentration)
- [x] Response detail filtering (`full` / `standard` / `minimal`) to protect scoring IP
- [x] Server running locally — 402 payment wall confirmed working
- [x] Health endpoint returning live data source status
- [x] Project status sheet created
- [x] All three endpoints tested with live data (BRETT B/82, DEGEN B/84, Uniswap Router B/70)
- [x] Dev test routes added (`/test/protocol`, `/test/token`, `/test/position`) — active only on base-sepolia
- [x] GitHub private repo created (nbsickler-ux/Sentinel)
- [x] Deployed to Render — public URL live, health check confirmed, 402 paywall verified
- [x] Bazaar discovery extensions deployed — agents can discover Sentinel via x402 facilitator
- [x] `/verify/counterparty` — 4-dimension counterparty scoring (sanctions 40%, reputation 30%, exploit 20%, type 10%)
- [x] OFAC SDN sanctions screening — 87 ETH addresses indexed from daily-updated GitHub list with fallback source
- [x] GoPlus address security integration — malicious, phishing, cybercrime, money laundering, darkweb, mixer detection
- [x] Exploit association checking against DeFiLlama protocol registry
- [x] Counterparty tested with known Tornado Cash sanctioned address — DANGER/F/34 confirmed
- [x] `/preflight` — unified pre-transaction safety check combining protocol + token + counterparty + position
- [x] Preflight hard blockers: OFAC sanctions and honeypot override composite score to DANGER/F
- [x] Preflight proceed/no-go recommendation with risk flag aggregation
- [x] Bazaar discovery extensions on all 5 paid endpoints
- [x] Dev test route `/test/preflight` added

## What's Next

### Immediate
- [ ] Push Phase 3 changes to GitHub → Render auto-deploy
- [ ] End-to-end paid verification test with a funded Sepolia wallet

### Phase 4 — Production Hardening
- [ ] Switch default `detail` level to `standard` for production
- [ ] Upstash Redis caching layer (5-15 min TTL)
- [ ] Rate limiting (25 free calls/wallet/day)
- [ ] Switch to Base Mainnet + production facilitator
- [ ] Write integration guide for agent builders

---

## Key Technical Decisions

1. **Global middleware over per-route** — @x402/express v2 uses `paymentMiddlewareFromConfig` with a routes config object. All paid routes defined in one place.
2. **CAIP-2 network IDs** — `eip155:84532` (Sepolia) and `eip155:8453` (Mainnet) instead of string names.
3. **USD price strings** — Prices like `"$0.008"` instead of raw token amounts. The facilitator handles conversion.
4. **Protocol registry preloading** — All 7,233 DeFiLlama protocols loaded and indexed by contract address on startup for O(1) lookups.
5. **Graceful fallbacks** — Every data source has a fallback if the API is down. Scoring continues with reduced confidence rather than failing.
6. **Response detail filtering** — `detail=full|standard|minimal` query param controls how much scoring methodology is exposed. Protects proprietary weights and dimension breakdowns from reverse engineering.
7. **Category risk tiers** — 14 DeFi categories mapped to inherent risk scores (Dexes: 80, Bridges: 45, Algo-Stables: 30, etc.) for position analysis.

---

## Known Issues

- DeFiLlama hacks endpoint is Pro-only; using the free protocol `hacked` flag instead (less granular)
- Governance and community dimensions in protocol scoring use placeholder values (65 and 60)
- Position analysis doesn't yet have on-chain position data (no liquidation proximity or IL calculation) — uses structural assessment
- OFAC sanctions list covers 87 ETH addresses; does not yet cover BTC or other chains
- No caching layer yet — each request hits external APIs fresh (will be addressed with Upstash Redis in Phase 4)
