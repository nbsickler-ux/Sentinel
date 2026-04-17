# Sentinel

**Trust infrastructure for autonomous AI agents on Base.**

*Verify before you execute. Every verification recorded on-chain.*

---

Autonomous agents are moving money on-chain. They're swapping tokens, entering DeFi positions, and interacting with contracts — often without human oversight. But the infrastructure for agents to assess whether an interaction is safe before executing it doesn't exist yet.

Sentinel fills that gap. It's a real-time trust verification service, built natively on [x402](https://www.x402.org), that answers the most critical question an autonomous agent faces before every on-chain action: **is this safe?**

Every paid verification creates an on-chain [EAS attestation](https://attest.org) on Base — a permanent, verifiable trust record. Returning agents build reputation over time, earning faster service through trust tiers. Agents can subscribe to monitoring webhooks for proactive risk alerts when conditions change.

Agents pay per query in USDC on Base. No accounts, no subscriptions, no API keys — just HTTP and a wallet.

**Live at:** [sentinel-awms.onrender.com](https://sentinel-awms.onrender.com)

## How It Works

```
Agent → POST /verify/token { "address": "0x..." }
     ← 402 Payment Required (x402 payment details)
Agent → Signs USDC payment on Base via x402
     ← 200 OK { verdict: "LOW_RISK", trust_grade: "B", confidence: 0.9, ... }
     → EAS attestation written to Base (async, post-response)
```

1. Agent sends a POST request with a JSON body to any `/verify/*` endpoint
2. Sentinel responds **HTTP 402** with x402 payment requirements
3. Agent signs a USDC payment on Base (automatic with x402-compatible clients)
4. Sentinel verifies the payment, runs multi-source trust analysis, returns a verdict
5. An on-chain EAS attestation is created asynchronously, recording the verification result permanently

The entire flow is stateless and HTTP-native. No auth tokens, no session management, no onboarding.

## Where Sentinel Fits

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) — co-authored by Coinbase — defines three registries for AI agent trust: Identity, Reputation, and Validation. The Identity registry is being implemented. The Reputation and Validation layers are explicitly left open for the ecosystem to build.

Sentinel is a live implementation of the Reputation and Validation layers. It doesn't replace agent identity — it complements it. A registered agent can still interact with a malicious contract. A human-backed agent (via [World AgentKit](https://world.org/agentkit)) can still enter a position that's about to collapse. Sentinel catches what identity alone can't.

The trust stack today:

| Layer | What It Does | Who Built It |
|-------|-------------|--------------|
| Payments | HTTP-native micropayments | x402 (Coinbase + Cloudflare) |
| Wallet Infrastructure | Spending controls, wallet ops | Agentic Wallets (Coinbase) |
| Human Identity | Prove a human is behind an agent | World AgentKit |
| Agent Identity | On-chain agent registry | ERC-8004 Identity Registry |
| **Behavioral Verification** | **Is this interaction safe?** | **Sentinel** |
| **On-chain Trust Records** | **Permanent verification attestations** | **Sentinel (EAS on Base)** |
| **Agent Reputation** | **Trust tiers from verification history** | **Sentinel** |
| **Proactive Monitoring** | **Webhook alerts on risk changes** | **Sentinel** |

## Endpoints

### Paid Verification Endpoints

All paid endpoints accept `POST` with a JSON body. All return structured trust assessments. All create on-chain EAS attestations.

#### POST /verify/protocol — $0.008 USDC

Is this smart contract trustworthy? Evaluates audit status, TVL, on-chain age, open-source verification, exploit history, and governance.

```bash
curl -X POST https://sentinel-awms.onrender.com/verify/protocol \
  -H "Content-Type: application/json" \
  -d '{"address": "0x2626664c2603336e57b271c5c0b26f421741e481", "chain": "base"}'
```

```json
{
  "address": "0x2626664c2603336e57b271c5c0b26f421741e481",
  "chain": "base",
  "verdict": "SAFE",
  "trust_grade": "A",
  "trust_score": 88,
  "confidence": 0.95,
  "risk_flags": [],
  "dimensions": {
    "audit": { "score": 90, "details": "..." },
    "exploit_history": { "score": 95, "details": "..." },
    "contract_maturity": { "score": 85, "details": "..." },
    "tvl_health": { "score": 88, "details": "..." },
    "governance": { "score": 80, "details": "..." }
  },
  "meta": {
    "sentinel_version": "0.4.0",
    "cache_hit": false
  }
}
```

#### POST /verify/token — $0.005 USDC

Is this token legitimate? Detects honeypots, fake tokens, tax manipulation, ownership concentration, and rugpull patterns.

```bash
curl -X POST https://sentinel-awms.onrender.com/verify/token \
  -H "Content-Type: application/json" \
  -d '{"address": "0x532f27101965dd16442E59d40670FaF5eBB142E4", "chain": "base"}'
```

```json
{
  "address": "0x532f27101965dd16442E59d40670FaF5eBB142E4",
  "chain": "base",
  "token_name": "Brett",
  "token_symbol": "BRETT",
  "verdict": "LOW_RISK",
  "trust_grade": "B",
  "trust_score": 82,
  "confidence": 0.9,
  "risk_flags": ["Slippage is modifiable by owner"],
  "meta": {
    "sentinel_version": "0.4.0",
    "cache_hit": false
  }
}
```

#### POST /verify/position — $0.005 USDC

Is this DeFi position safe? Analyzes protocol trust, liquidity depth, impermanent loss risk, concentration, and utilization.

```bash
curl -X POST https://sentinel-awms.onrender.com/verify/position \
  -H "Content-Type: application/json" \
  -d '{"protocol": "0x2626664c2603336e57b271c5c0b26f421741e481", "chain": "base"}'
```

#### POST /verify/counterparty — $0.010 USDC

Is this wallet safe to interact with? Checks OFAC sanctions, contract verification, exploit association, wallet age, and activity patterns.

```bash
curl -X POST https://sentinel-awms.onrender.com/verify/counterparty \
  -H "Content-Type: application/json" \
  -d '{"address": "0x1234567890abcdef1234567890abcdef12345678", "chain": "base"}'
```

#### POST /preflight — $0.025 USDC

Should I execute this transaction? Runs protocol, token, counterparty, and position checks in parallel. Returns a single go/no-go recommendation.

```bash
curl -X POST https://sentinel-awms.onrender.com/preflight \
  -H "Content-Type: application/json" \
  -d '{"target": "0x2626664c2603336e57b271c5c0b26f421741e481", "chain": "base"}'
```

```json
{
  "target": "0x2626664c2603336e57b271c5c0b26f421741e481",
  "chain": "base",
  "verdict": "SAFE",
  "trust_grade": "A",
  "composite_score": 87,
  "proceed": true,
  "proceed_recommendation": "Transaction appears safe to execute",
  "checks_summary": {
    "protocol": "SAFE",
    "token": null,
    "counterparty": null,
    "position": "LOW_RISK"
  },
  "meta": {
    "sentinel_version": "0.4.0"
  }
}
```

#### POST /watch — $0.05 USDC

Subscribe to monitoring. Get webhook alerts when a target address's risk profile changes.

```bash
curl -X POST https://sentinel-awms.onrender.com/watch \
  -H "Content-Type: application/json" \
  -d '{"target": "0x...", "chain": "base", "webhook_url": "https://your-agent.com/alerts"}'
```

### Free Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Service overview, capabilities, and quick-start guide |
| `GET /health` | Status, capabilities (attestation/reputation/monitoring), endpoint catalog |
| `GET /openapi.json` | OpenAPI 3.1 spec for agent framework integration |
| `GET /.well-known/x402` | x402 discovery document |
| `GET /attestation/:address` | Look up existing Sentinel EAS attestations for any address |
| `GET /agent/:wallet` | Check an agent's reputation tier, verification count, and trust standing |

### Common Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `address` / `target` | string | required | The on-chain address to verify (0x + 40 hex chars) |
| `chain` | string | `"base"` | `"base"` (mainnet) or `"base-sepolia"` (testnet) |
| `detail` | string | `"full"` | Response detail level: `"full"`, `"standard"`, or `"minimal"` |

## On-Chain Attestations

Every paid verification creates an [EAS (Ethereum Attestation Service)](https://attest.org) attestation on Base. This means every trust verdict Sentinel produces is permanently recorded on-chain and independently verifiable.

The attestation schema includes: target address, chain, endpoint type, trust score, verdict, trust grade, proceed recommendation, risk flags, timestamp, and x402 payment ID.

Schema UID: [`0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04`](https://base.easscan.org/schema/view/0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04)

Agents can check existing attestations before paying via `GET /attestation/:address` — if Sentinel has already verified an address recently, the attestation is already on-chain and queryable for free.

## Agent Reputation

Sentinel tracks agent reputation based on verification history. Agents that verify consistently earn trust tiers with tangible benefits:

| Tier | Requirement | Cache TTL | Benefits |
|------|-------------|-----------|----------|
| Unknown | < 5 verifications | Standard | Default service |
| Recognized | 5+ verifications | Extended | Longer cache windows, OFAC skip for known-clean agents |
| Trusted | 20+ verifications | Maximum | Fastest response times, priority processing |

Reputation is tracked per wallet address. Check any agent's standing via `GET /agent/:wallet`.

## Monitoring Webhooks

Agents can subscribe to proactive risk monitoring via `POST /watch`. Sentinel runs a background scanner (30-minute interval) that re-evaluates watched addresses and delivers webhook alerts when risk profiles change.

Watchlist capacity: 100 active monitors. Webhook payloads include the full re-evaluation result so agents can act immediately on risk changes.

## Trust Verdicts

Every verification returns a verdict, grade, score, and confidence level:

| Verdict | Grade | Score Range | Meaning |
|---------|-------|-------------|---------|
| `SAFE` | A | 85–100 | Proceed — no elevated risk detected |
| `LOW_RISK` | B | 70–84 | Proceed — minor flags noted |
| `CAUTION` | C | 55–69 | Reduce exposure — notable risks present |
| `HIGH_RISK` | D | 40–54 | Human review recommended |
| `DANGER` | F | 0–39 | Do not proceed — critical risk indicators |

## Agent Integration

Sentinel works with any x402-compatible client. The payment flow is handled automatically — your agent code just makes a normal HTTP request.

### Using @x402/fetch

```javascript
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const client = new x402Client();
registerExactEvmScheme(client, { signer: walletClient });
const httpClient = new x402HTTPClient(client);

// The x402 client handles the 402 → payment → retry flow automatically
const response = await fetch("https://sentinel-awms.onrender.com/verify/token", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: "0x...", chain: "base" }),
});

if (response.status === 402) {
  // Sign payment and retry — see scripts/pay-test.js for full example
}
```

### Using Coinbase AgentKit

AgentKit agents with x402 payment capabilities can call Sentinel directly. The x402 middleware handles payment negotiation transparently.

### Preflight Pattern

The recommended integration pattern for autonomous agents:

```javascript
async function executeTransaction(target, token, counterparty) {
  // Run preflight check before any on-chain action
  const check = await sentinel.preflight({ target, token, counterparty, chain: "base" });

  if (!check.proceed) {
    console.log(`Blocked: ${check.verdict} — ${check.proceed_recommendation}`);
    return;
  }

  // Safe to proceed — attestation is written to Base automatically
  await executeOnChain(target, token, counterparty);
}
```

A working payment client is included at [`scripts/pay-test.js`](./scripts/pay-test.js).

## Architecture

Sentinel uses a three-path architecture optimized for speed:

**Hot path** (sub-5s responses): Verification requests are served from cached data where available, with real-time multi-source aggregation for cache misses. Agent reputation tiers adjust cache TTLs — trusted agents get longer cache windows for faster responses.

**Post-response path** (async): After returning the verdict, Sentinel writes EAS attestations to Base and updates the agent's reputation profile. This keeps response times fast while ensuring on-chain records are created for every verification.

**Background path** (periodic): A scanner re-evaluates watched addresses every 30 minutes and delivers webhook alerts on risk changes. Daily compliance reports are generated automatically.

Data sources aggregated in real time:

- **GoPlus Security** — Token security analysis, honeypot detection, address reputation
- **DeFiLlama** — Protocol registry (2,800+ Base addresses), TVL data, exploit history, governance metadata
- **Etherscan V2** — Contract source verification, proxy detection, deployment age
- **Alchemy RPC** — Bytecode existence and contract type checks
- **OFAC SDN List** — Sanctioned address screening (loaded at startup)
- **EAS (Base)** — On-chain attestation storage for verification records
- **Upstash Redis** — Response caching (tier-adjusted TTLs), reputation tracking, rate limiting
- **PostgreSQL** — Compliance audit trail, daily reports, request logging

Responses include a `confidence` score (0.0–1.0) reflecting how many data sources returned results for a given query.

## Self-Hosting

```bash
git clone https://github.com/nbsickler-ux/Sentinel.git
cd Sentinel
npm install
cp .env.example .env   # Fill in your keys
npm run dev
```

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `WALLET_ADDRESS` | Yes | Your USDC receiving address on Base |
| `NETWORK` | Yes | `base` (mainnet) or `base-sepolia` (testnet) |
| `CDP_API_KEY_ID` | Yes | Coinbase Developer Platform API key |
| `CDP_API_KEY_SECRET` | Yes | CDP API secret |
| `ALCHEMY_API_KEY` | Yes | Alchemy RPC for bytecode checks |
| `BASESCAN_API_KEY` | Yes | Etherscan V2 for contract metadata |
| `GOPLUS_API_KEY` | Yes | GoPlus Security API key |
| `GOPLUS_API_SECRET` | Yes | GoPlus API secret |
| `UPSTASH_REDIS_REST_URL` | Yes | Redis for caching, reputation, and rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis token |
| `SENTINEL_DEPLOYER_KEY` | Yes | Private key for EAS attestation signing |
| `EAS_SCHEMA_UID` | Yes | EAS schema UID (from deploy-schema.js) |
| `DATABASE_URL` | Yes | PostgreSQL connection string for audit trail |
| `SENTINEL_ADMIN_KEY` | No | Enables `/admin/stats` endpoint |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |

## Admin Audit Report

With `SENTINEL_ADMIN_KEY` set in `.env`, run the helper script for a pretty-printed report of calls made to Sentinel:

```bash
./scripts/audit-report.sh            # /admin/stats (default)
./scripts/audit-report.sh audit      # full audit trail
./scripts/audit-report.sh summary    # aggregated summary
```

The script loads the key from `.env` (gitignored) and scopes it to the curl invocation only.

## Rate Limiting

Free tier: 25 calls per wallet address per day (sliding window). Rate limit headers are included on every response:

```
X-RateLimit-Limit: 25
X-RateLimit-Remaining: 23
X-RateLimit-Reset: 1711497600000
```

## Testing

```bash
npm test
```

49 tests covering scoring logic, response filtering, sanctions screening, and input validation. Tests use extracted pure functions from `lib/scoring.js` to avoid side-effect initialization.

## Build With Sentinel

If you're building autonomous agents on Base and want to integrate trust verification into your agent's decision loop, Sentinel is live and ready. Hit the endpoints, read the [OpenAPI spec](https://sentinel-awms.onrender.com/openapi.json), or check the [.well-known/x402](https://sentinel-awms.onrender.com/.well-known/x402) discovery document.

Every verification you run creates a permanent on-chain trust record. Your agent builds reputation over time. And you can subscribe to monitoring for proactive risk alerts.

Questions, integrations, or feedback: open an issue or reach out.

## License

MIT
