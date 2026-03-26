# Sentinel — Research Notes & Reference

## Core Concept
Sentinel is an x402-gated verification service answering: "Is this interaction safe?" for autonomous AI agents. Agents pay per request in USDC on Base. No accounts, no API keys.

---

## x402 Protocol

### What It Is
HTTP-native payment protocol. Server responds 402 Payment Required with payment details. Client pays, resubmits with proof, server delivers content. Works with any HTTP client — including autonomous agents.

### Key Resources
- x402 specification: https://www.x402.org/
- Express middleware: `@x402/express` npm package
- Testnet facilitator: https://x402.org/facilitator
- Production facilitator: https://api.developer.coinbase.com/x402/facilitator

### Payment Flow
1. Agent sends GET request to paid endpoint
2. Sentinel returns HTTP 402 + JSON payment requirements (amount, asset, network, facilitator)
3. Agent signs USDC payment on Base and submits to facilitator
4. Facilitator verifies payment, returns proof
5. Agent re-sends request with payment proof header
6. Sentinel verifies proof via facilitator, returns trust assessment

### x402 V2 (Future)
Session tokens for high-frequency agents: pre-authorize $5–$50, get hundreds of calls at discount. Reduces per-transaction blockchain overhead.

---

## Bazaar Discovery Layer

### What It Is
Service discovery for x402 — lets agents find and pay for services autonomously. Think "app store for agent APIs."

### Integration Plan
- Register Sentinel as a service with discovery metadata
- Include endpoint descriptions, pricing, input/output schemas
- The `paymentMiddleware` already supports Bazaar metadata via `description`, `input`, and `output` fields

---

## Data Sources — Phase 1

### DeFiLlama (Free, No API Key)
- **TVL API**: `https://api.llama.fi/protocol/{slug}` — current TVL, historical data, chain breakdowns
- **Hacks API**: `https://api.llama.fi/hacks` — known exploits with amounts, dates, types (needs investigation)
- **Protocols list**: `https://api.llama.fi/protocols` — all tracked protocols with slugs
- **Status**: TVL endpoint partially integrated (slug mapping TODO), hacks endpoint not yet used
- **Note**: Need to build a mapping layer: contract address → DeFiLlama protocol slug

### Alchemy (Free Tier: 300M Compute Units/Month)
- **eth_getCode**: Check if address is a contract (already integrated)
- **eth_getTransactionCount**: Transaction history
- **Base Sepolia**: `https://base-sepolia.g.alchemy.com/v2/{key}`
- **Base Mainnet**: `https://base-mainnet.g.alchemy.com/v2/{key}`
- **Status**: Basic contract check integrated, need to expand

### Etherscan/Basescan (Free Tier: 5 calls/sec)
- Contract source verification status
- Contract creation date (deployment timestamp)
- Proxy implementation detection
- ABI retrieval
- **API**: `https://api.basescan.org/api?module=contract&action=getsourcecode&address={addr}&apikey={key}`
- **Status**: Not yet integrated

---

## Data Sources — Phase 2+

### Audit Aggregators
- **Solodit**: Aggregates audit findings across firms (need to investigate API availability)
- **DeFiSafety**: Protocol safety scores and reviews
- **Status**: Currently using hardcoded known-audited list

### Sanctions & Compliance
- **OFAC SDN List**: US Treasury sanctions, downloadable as XML/CSV, updated regularly
  - URL: https://sanctionslist.ofac.treas.gov/
  - Includes crypto wallet addresses since 2022
- **Chainalysis/Elliptic**: Commercial — enterprise pricing, probably out of scope for Phase 1–3
- **Status**: Phase 3 priority

### Exploit/Hack Databases
- **rekt.news**: Exploit database with details, amounts, types — need to check for API
- **DeFiLlama hacks**: May have an API endpoint (investigate)
- **Status**: Currently hardcoded known exploits

### Token Analysis
- **GoPlusLabs**: Token security detection API (honeypot, trading tax, ownership)
  - API: `https://api.gopluslabs.com/api/v1/token_security/{chain_id}?contract_addresses={addr}`
  - Free tier available
- **Status**: Phase 2, for /verify/token endpoint

---

## Competitive Landscape

### Direct Competitors
- **GoPlus / De.Fi**: Closest — freemium token security APIs, not x402-native, focused on retail
- **CipherOwl**: Enterprise compliance/monitoring, not agent-native
- **Nansen**: Dashboard-first analytics, expensive subscriptions, minutes-lag

### Sentinel Differentiators
1. x402-native (zero friction for agents)
2. Sub-200ms response target
3. Multiple verification domains in one service
4. Structured verdicts with action guidance (not raw data)
5. Built for autonomous agents, not human dashboards

---

## Technical Architecture Notes

### Current Stack
- Runtime: Node.js + Express
- Payment: @x402/express middleware
- Data: Axios for external API calls
- Config: dotenv

### Planned Additions
- **Caching**: Upstash Redis — cache verification results by (address, chain) with 5–15 minute TTL
- **Deployment**: Railway or Cloudflare Workers (need always-on for Bazaar discovery)
- **Monitoring**: Basic request logging → Prometheus/Grafana at scale

### Scoring Architecture
- Six dimensions per protocol, weighted and composited (0–100)
- Grade thresholds: A(85+), B(70–84), C(55–69), D(40–54), F(0–39)
- Confidence score based on data availability (mock data → low confidence)
- Risk flags as human-readable strings for agent decision-making

---

## Business Model Notes

### Pricing Anchors
- Below the cost of getting it wrong (bad interaction = $100s–$1000s lost)
- Above commodity data feeds ($0.001–$0.002/call)
- In line with x402 ecosystem ($0.005–$0.05/call)

### Revenue Scenarios (from Blueprint)
- Conservative: 5K calls/day → ~$1,200/month
- Moderate: 50K calls/day → ~$15,000/month
- Aggressive: 500K calls/day → ~$180,000/month

### Key Insight
Gross margins are 96–99% because infrastructure costs scale sub-linearly (caching), while revenue scales linearly with calls.

### Free Tier Strategy
25 free calls per wallet per day. Critical for Bazaar discovery — agents test before committing spend authorization. Converts to paid on call 26+.

---

## DSC Content Integration
Sentinel maps to the Do Something Collective methodology: Discover → Define → Connect → Launch → Scale → Optimize. YouTube narrative: "I started by asking what I could build. Then I asked what agents actually need."

---

## Open Questions & Decisions Needed

1. **Hosting**: Railway vs. Cloudflare Workers? Workers = edge performance + free tier, Railway = simpler for stateful services
2. **Business entity**: S-Corp integration for USDC revenue — discuss with spouse
3. **Contract-to-slug mapping**: How to map arbitrary contract addresses to DeFiLlama protocol slugs? May need a manual mapping table initially
4. **Audit data source**: Is there a free, API-accessible audit aggregator? Or build a curated list?
5. **Domain**: sentinel-api.xyz? sentinel.dosomethingcollective.com?
6. **Rate limiting**: How to handle the free tier without account system? Per-wallet tracking on Base addresses
7. **Error handling**: What to return when third-party data sources are down? Degrade gracefully with lower confidence scores?

---

## Quick Links
- Coinbase Developer Platform: https://portal.cdp.coinbase.com/
- Alchemy Dashboard: https://dashboard.alchemy.com/
- DeFiLlama API Docs: https://defillama.com/docs/api
- x402 Docs: https://www.x402.org/
- Basescan API: https://docs.basescan.org/
- GoPlusLabs API: https://docs.gopluslabs.com/
- OFAC Sanctions: https://sanctionslist.ofac.treas.gov/
