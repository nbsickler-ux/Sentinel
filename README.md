# Sentinel

**The trust layer for autonomous agents.**

*Verify before you execute.*

Sentinel is an x402-gated verification service that answers one question for any autonomous AI agent: **is this interaction safe?**

Agents pay per request in USDC on Base. No accounts, no subscriptions, no API keys.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your wallet address + API keys
npm run dev
```

## Endpoints

| Endpoint | Price | Status | Description |
|----------|-------|--------|-------------|
| `GET /verify/protocol?address=0x...` | $0.008 | **Live** | Protocol trust verification |
| `GET /verify/position?wallet=0x...` | $0.005 | Phase 2 | Position risk analysis |
| `GET /verify/token?address=0x...` | $0.005 | Phase 2 | Token legitimacy check |
| `GET /verify/counterparty?address=0x...` | $0.01 | Phase 3 | Counterparty intelligence |
| `GET /preflight` | $0.025 | Phase 4 | Unified pre-transaction safety |
| `GET /health` | Free | **Live** | Service status |

## How It Works

1. Agent calls `/verify/protocol?address=0xAbc...`
2. Sentinel responds HTTP 402 + payment requirements
3. Agent pays $0.008 USDC on Base via x402
4. Sentinel verifies payment, runs trust analysis, returns verdict

## Trust Verdicts

| Verdict | Grade | Meaning |
|---------|-------|---------|
| SAFE | A | Proceed — no elevated risk |
| LOW_RISK | B | Proceed — minor flags noted |
| CAUTION | C | Reduce exposure — notable risks |
| HIGH_RISK | D | Human review recommended |
| DANGER | F | Do not proceed — critical risk |

## Roadmap

- **Phase 1** (Weeks 1–3): Protocol verification on testnet → mainnet
- **Phase 2** (Weeks 4–6): Position risk + token verification
- **Phase 3** (Months 2–3): Counterparty intelligence + sanctions
- **Phase 4** (Month 3+): Unified /preflight endpoint

See `Sentinel-Blueprint.docx` for the complete build plan, pricing model, and verification scoring methodology.
