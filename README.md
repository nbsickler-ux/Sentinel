# Sentinel

**The trust layer for autonomous agents on Base.**

*Verify before you execute.*

Sentinel is an x402-gated trust verification service that answers one question for any autonomous AI agent: **is this interaction safe?**

Agents pay per request in USDC on Base. No accounts, no subscriptions, no API keys — just HTTP and a wallet.

**Live at:** [sentinel-awms.onrender.com](https://sentinel-awms.onrender.com)

## How It Works

1. Agent calls any `/verify/*` endpoint (e.g., `/verify/protocol?address=0xAbc...&chain=base`)
2. Sentinel responds **HTTP 402** with x402 payment requirements
3. Agent pays USDC on Base via the x402 protocol (automatic with AgentKit, x402-axios, etc.)
4. Sentinel verifies payment, runs multi-source trust analysis, returns a verdict

## Endpoints

| Endpoint | Price | Description |
|----------|-------|-------------|
| `GET /verify/protocol?address=0x...` | $0.008 USDC | Protocol trust verification — audits, exploits, contract maturity, TVL, governance |
| `GET /verify/token?address=0x...` | $0.005 USDC | Token safety — honeypot detection, tax analysis, ownership risks, holder distribution |
| `GET /verify/position?protocol=0x...` | $0.005 USDC | DeFi position risk — protocol trust + category risk + TVL health + concentration |
| `GET /verify/counterparty?address=0x...` | $0.010 USDC | Counterparty intelligence — OFAC sanctions, address reputation, exploit association |
| `GET /preflight?target=0x...` | $0.025 USDC | Unified pre-transaction safety check combining all verification domains |
| `GET /health` | Free | Service status, endpoint catalog, facilitator info |
| `GET /` | Free | Service description and quick-start guide for agent discovery |
| `GET /openapi.json` | Free | OpenAPI 3.1 spec for agent framework integration |

All paid endpoints accept `?chain=base` (default) or `?chain=base-sepolia` and `?detail=full|standard|minimal`.

## Trust Verdicts

| Verdict | Grade | Score | Meaning |
|---------|-------|-------|---------|
| SAFE | A | 85–100 | Proceed — no elevated risk |
| LOW_RISK | B | 70–84 | Proceed — minor flags noted |
| CAUTION | C | 55–69 | Reduce exposure — notable risks |
| HIGH_RISK | D | 40–54 | Human review recommended |
| DANGER | F | 0–39 | Do not proceed — critical risk |

## Quick Start (Self-Hosting)

```bash
git clone https://github.com/nbsickler-ux/Sentinel.git
cd Sentinel
npm install
cp .env.example .env   # Fill in wallet address + API keys
npm run dev
```

### Required Environment Variables

| Variable | Purpose |
|----------|---------|
| `WALLET_ADDRESS` | Your USDC receiving wallet on Base |
| `NETWORK` | `base` (mainnet) or `base-sepolia` (testnet) |
| `CDP_API_KEY_ID` | Coinbase Developer Platform API key (Ed25519) |
| `CDP_API_KEY_SECRET` | CDP API secret |
| `ALCHEMY_API_KEY` | Alchemy RPC for bytecode checks |
| `BASESCAN_API_KEY` | Etherscan V2 for contract metadata |
| `GOPLUS_API_KEY` | GoPlus Security API key |
| `GOPLUS_API_SECRET` | GoPlus API secret |
| `UPSTASH_REDIS_REST_URL` | Optional — enables caching + rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | Optional — Upstash Redis token |

## Agent Integration

Sentinel works with any x402-compatible agent framework:

```javascript
// Using x402-axios (recommended)
import { wrapAxios } from "@anthropic-ai/x402-axios";
import axios from "axios";

const client = wrapAxios(axios, wallet);
const result = await client.get(
  "https://sentinel-awms.onrender.com/verify/protocol?address=0x...&chain=base"
);
console.log(result.data.verdict); // "SAFE", "LOW_RISK", "CAUTION", etc.
```

See [INTEGRATION.md](./INTEGRATION.md) for full integration examples with AgentKit, LangChain, CrewAI, and ElizaOS.

## Architecture

Sentinel aggregates data from multiple on-chain and off-chain sources in parallel:

- **GoPlus Security** — Token security, honeypot detection, address reputation
- **DeFiLlama** — Protocol registry (2,800+ Base addresses), TVL, exploit history, governance metadata
- **Etherscan V2** — Contract source verification, proxy detection, deployment age
- **Alchemy RPC** — Bytecode existence checks
- **OFAC SDN** — 87 sanctioned ETH addresses (daily-updated)
- **Upstash Redis** — Response caching (5–15 min TTL) + rate limiting (25 calls/wallet/day free tier)

## Rate Limiting

Free tier: 25 calls per wallet per day (sliding window). Rate limit headers are included on every response:

```
X-RateLimit-Limit: 25
X-RateLimit-Remaining: 23
X-RateLimit-Reset: 1711497600000
```

## License

MIT
