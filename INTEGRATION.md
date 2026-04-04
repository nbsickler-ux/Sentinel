# Sentinel Integration Guide

**Add trust verification to your agent in under 5 minutes.**

Sentinel is the trust layer for autonomous AI agents on Base. Before your agent swaps a token, enters a DeFi position, or interacts with a contract — Sentinel tells it whether it's safe.

**Free tier: 25 calls/day. No wallet, no payment, no signup.**

---

## Quick Start

Every verification endpoint works the same way: POST a JSON body with an address, get back a trust verdict.

```bash
curl -X POST https://sentinel-awms.onrender.com/verify/token \
  -H "Content-Type: application/json" \
  -d '{"address": "0x532f27101965dd16442E59d40670FaF5eBB142E4", "chain": "base"}'
```

Response:

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

That's it. No authentication, no API keys, no payment for the first 25 calls/day.

Check the `X-FreeTier-Remaining` response header to see how many free calls you have left.

---

## Endpoints

All endpoints accept `POST` with a JSON body.

| Endpoint | What It Answers | Input |
|----------|----------------|-------|
| `POST /verify/protocol` | Is this smart contract trustworthy? | `{ "address": "0x..." }` |
| `POST /verify/token` | Is this token safe to hold/swap? | `{ "address": "0x..." }` |
| `POST /verify/position` | Is this DeFi position safe? | `{ "address": "0x..." }` |
| `POST /verify/counterparty` | Is this wallet safe to interact with? | `{ "address": "0x..." }` |
| `POST /preflight` | Should I execute this transaction? | `{ "target": "0x..." }` |

All endpoints accept optional parameters: `chain` (default: `"base"`), `detail` (`"full"`, `"standard"`, or `"minimal"`).

---

## Using the Verdict in Your Agent

Every response includes a `verdict` and a `proceed` recommendation (for preflight). Here's how to wire it into your agent's decision loop:

```javascript
async function verifyBeforeSwap(tokenAddress) {
  const res = await fetch("https://sentinel-awms.onrender.com/verify/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: tokenAddress, chain: "base" }),
  });

  const result = await res.json();

  // Use the verdict to gate your agent's action
  if (result.verdict === "DANGER" || result.verdict === "HIGH_RISK") {
    console.log(`Blocked: ${result.verdict} — ${result.risk_flags.join(", ")}`);
    return false;
  }

  console.log(`Safe to proceed: ${result.verdict} (${result.trust_grade})`);
  return true;
}
```

### Preflight Pattern (Recommended)

For transactions involving multiple components (protocol + token + counterparty), use the `/preflight` endpoint. It runs all checks in parallel and returns a single go/no-go:

```javascript
async function preflightCheck(target, token, counterparty) {
  const res = await fetch("https://sentinel-awms.onrender.com/preflight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target, token, counterparty, chain: "base" }),
  });

  const result = await res.json();

  if (!result.proceed) {
    console.log(`BLOCKED: ${result.verdict} — ${result.proceed_recommendation}`);
    return false;
  }

  // Safe — an EAS attestation is written to Base automatically
  return true;
}
```

---

## Coinbase AgentKit Integration

If your agent uses AgentKit, Sentinel works as a pre-execution hook:

```javascript
import { CdpAgentkit } from "@coinbase/cdp-agentkit-core";

// Add Sentinel as a verification step before any on-chain action
async function sentinelVerify(address, type = "protocol") {
  const endpoint = type === "token" ? "/verify/token" : "/verify/protocol";
  const res = await fetch(`https://sentinel-awms.onrender.com${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, chain: "base" }),
  });
  return res.json();
}

// In your agent's action handler:
const verdict = await sentinelVerify(targetContract);
if (verdict.trust_score < 55) {
  // Don't execute — risk is too high
  return { blocked: true, reason: verdict.risk_flags };
}
// Proceed with AgentKit action...
```

---

## Python Integration

```python
import requests

def verify_token(address: str, chain: str = "base") -> dict:
    """Check if a token is safe before swapping."""
    response = requests.post(
        "https://sentinel-awms.onrender.com/verify/token",
        json={"address": address, "chain": chain},
    )
    return response.json()

result = verify_token("0x532f27101965dd16442E59d40670FaF5eBB142E4")

if result["verdict"] in ("DANGER", "HIGH_RISK"):
    print(f"BLOCKED: {result['risk_flags']}")
else:
    print(f"Safe: {result['verdict']} ({result['trust_grade']})")
```

---

## ElizaOS Plugin

```javascript
// In your ElizaOS agent action:
const sentinelCheck = {
  name: "SENTINEL_VERIFY",
  description: "Verify a protocol before interacting",
  handler: async (runtime, message, state) => {
    const address = extractAddress(message.content);
    const response = await fetch(
      `https://sentinel-awms.onrender.com/verify/protocol`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, chain: "base", detail: "standard" }),
      }
    );
    const result = await response.json();
    return `Protocol ${address}: ${result.trust_grade} (${result.verdict}). ${result.risk_flags?.join(". ") || "No flags."}`;
  },
};
```

---

## Trust Verdicts

| Verdict | Grade | Score | What To Do |
|---------|-------|-------|------------|
| `SAFE` | A | 85-100 | Proceed normally |
| `LOW_RISK` | B | 70-84 | Proceed — minor flags noted |
| `CAUTION` | C | 55-69 | Reduce exposure, review flags |
| `HIGH_RISK` | D | 40-54 | Human review recommended |
| `DANGER` | F | 0-39 | Do not proceed |

---

## Response Detail Levels

Control how much data comes back with the `detail` parameter:

- **`full`** (default) — Everything: verdict, grade, score, all dimensions, evidence, risk flags
- **`standard`** — Verdict, grade, evidence, risk flags (hides scoring weights)
- **`minimal`** — Verdict and grade only — fastest parsing

---

## Free Tier & Pricing

**Free tier**: 25 calls per day per IP address. No wallet or payment required. Resets daily.

After the free tier, x402 payment kicks in automatically:

| Endpoint | Price per call |
|----------|---------------|
| `/verify/protocol` | $0.008 USDC |
| `/verify/token` | $0.005 USDC |
| `/verify/position` | $0.005 USDC |
| `/verify/counterparty` | $0.010 USDC |
| `/preflight` | $0.025 USDC |

Payment is handled by the [x402 protocol](https://www.x402.org) — your agent signs a USDC payment on Base, and the x402 middleware verifies it automatically. If you're using an x402-compatible client, the payment flow is transparent.

### Response Headers

Every response includes free-tier quota headers:

```
X-FreeTier-Limit: 25
X-FreeTier-Remaining: 22
X-FreeTier-Reset: 1711584000000
```

---

## On-Chain Attestations

Every verification creates an [EAS attestation](https://attest.org) on Base — a permanent, verifiable trust record. Check existing attestations before running a new verification:

```bash
curl https://sentinel-awms.onrender.com/attestation/0x2626664c2603336e57b271c5c0b26f421741e481
```

If Sentinel has already verified an address recently, the attestation is on-chain and queryable for free.

Schema UID: [`0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04`](https://base.easscan.org/schema/view/0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04)

---

## Agent Reputation

Agents that verify consistently earn trust tiers with tangible benefits:

| Tier | Requirement | Benefit |
|------|-------------|---------|
| Unknown | < 5 verifications | Standard service |
| Recognized | 5+ verifications | Extended cache windows |
| Trusted | 20+ verifications | Fastest response times |

Reputation is tracked per wallet address (set by x402 after payment). Check any agent's standing:

```bash
curl https://sentinel-awms.onrender.com/agent/0xYourWalletAddress
```

---

## Caching

Results are cached for 5-15 minutes depending on the endpoint. Repeated queries for the same address return cached results with `cache_hit: true` in the response metadata — sub-50ms responses on cache hits.

---

## Links

- **Live API**: [sentinel-awms.onrender.com](https://sentinel-awms.onrender.com)
- **OpenAPI Spec**: [/openapi.json](https://sentinel-awms.onrender.com/openapi.json)
- **x402 Discovery**: [/.well-known/x402](https://sentinel-awms.onrender.com/.well-known/x402)
- **GitHub**: [github.com/nbsickler-ux/Sentinel](https://github.com/nbsickler-ux/Sentinel)
- **EAS Schema**: [View on Base EAS](https://base.easscan.org/schema/view/0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04)

Questions or integration help? Open an issue on GitHub or email sentinel@dosomethingcollective.com
