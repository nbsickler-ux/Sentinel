# Sentinel — Integration Guide for Agent Builders

## Quick Start

Sentinel is an x402-gated verification API. Your agent pays per request in USDC on Base — no accounts, no API keys, no subscriptions.

**Base URL:** `https://sentinel-awms.onrender.com`

### How x402 Works

1. Your agent sends a GET request to any paid endpoint
2. Sentinel responds with HTTP `402 Payment Required` and a JSON payment header
3. Your agent signs a USDC payment on Base and submits it to the x402 facilitator
4. The facilitator returns payment proof
5. Your agent re-sends the original request with the payment proof header
6. Sentinel verifies the proof and returns the trust assessment

If you're using Coinbase AgentKit or any x402-compatible client, steps 2–5 are handled automatically.

---

## Endpoints

### GET /verify/protocol — $0.008 USDC
Trust assessment for any smart contract.

```
GET /verify/protocol?address=0x2626664c2603336e57b271c5c0b26f421741e481&chain=base
```

**Parameters:**
- `address` (required) — Contract address (0x + 40 hex chars)
- `chain` — `base` (default) or `base-sepolia`
- `detail` — `full` (default), `standard`, or `minimal`

**Returns:** Trust grade (A–F), verdict (SAFE/LOW_RISK/CAUTION/HIGH_RISK/DANGER), audit status, exploit history, contract maturity, TVL stability, risk flags.

---

### GET /verify/token — $0.005 USDC
Token safety check: honeypot detection, tax analysis, ownership risks.

```
GET /verify/token?address=0x532f27101965dd16442E59d40670FaF5eBB142E4&chain=base
```

**Parameters:**
- `address` (required) — Token contract address
- `chain` — `base` or `base-sepolia`
- `detail` — `full`, `standard`, or `minimal`

**Returns:** Honeypot status, buy/sell tax, ownership control flags, holder distribution, trading restrictions.

---

### GET /verify/position — $0.005 USDC
DeFi position risk analysis.

```
GET /verify/position?protocol=0x2626664c2603336e57b271c5c0b26f421741e481&chain=base
```

**Parameters:**
- `protocol` (required) — Protocol contract address
- `user` (optional) — User wallet address
- `chain` — `base` or `base-sepolia`
- `detail` — `full`, `standard`, or `minimal`

**Returns:** Protocol trust foundation, category risk tier, TVL health, concentration risk, actionable recommendations.

---

### GET /verify/counterparty — $0.01 USDC
Counterparty intelligence: sanctions screening, address reputation.

```
GET /verify/counterparty?address=0x1234...&chain=base
```

**Parameters:**
- `address` (required) — Wallet or contract address to screen
- `chain` — `base` or `base-sepolia`
- `detail` — `full`, `standard`, or `minimal`

**Returns:** OFAC SDN sanctions check, GoPlus reputation flags (malicious, phishing, cybercrime, mixer, money laundering), exploit association.

---

### GET /preflight — $0.025 USDC
Unified pre-transaction safety check. Combines all verification domains in one call.

```
GET /preflight?target=0xProtocol...&token=0xToken...&counterparty=0xWallet...&chain=base
```

**Parameters:**
- `target` (required) — Primary contract address for the transaction
- `token` (optional) — Token address involved
- `counterparty` (optional) — Counterparty wallet address
- `chain` — `base` or `base-sepolia`
- `detail` — `full`, `standard`, or `minimal`

**Returns:** Composite trust score, proceed/no-go recommendation, individual grades for each check, aggregated risk flags. Hard blockers (OFAC sanctions, honeypots) automatically override to DANGER.

---

### GET /health — Free
Service status and endpoint catalog. No payment required.

```
GET /health
```

---

## Response Detail Levels

Control how much data is returned with the `detail` parameter:

- **`full`** — Everything: verdict, grade, score, all dimensions, evidence, risk flags. Best for debugging and analysis.
- **`standard`** — Verdict, grade, evidence, risk flags. Hides scoring dimension weights. Good for production.
- **`minimal`** — Verdict and grade only. Fastest parsing, maximum IP protection.

---

## Trust Verdict Scale

| Verdict | Grade | Score | Recommended Action |
|---------|-------|-------|--------------------|
| SAFE | A | 85–100 | Proceed — no elevated risk |
| LOW_RISK | B | 70–84 | Proceed — minor flags noted |
| CAUTION | C | 55–69 | Reduce exposure — notable risks |
| HIGH_RISK | D | 40–54 | Human review recommended |
| DANGER | F | 0–39 | Do not proceed |

---

## Integration Examples

### Coinbase AgentKit (Node.js)

AgentKit handles x402 payments automatically. Just make the request:

```javascript
const response = await fetch(
  "https://sentinel-awms.onrender.com/verify/protocol?address=0x2626664c2603336e57b271c5c0b26f421741e481&chain=base"
);

// AgentKit's x402 client automatically:
// 1. Receives the 402 response
// 2. Signs USDC payment on Base
// 3. Submits to facilitator
// 4. Retries with payment proof

const result = await response.json();

if (result.verdict === "DANGER" || result.trust_grade === "F") {
  console.log("DO NOT INTERACT:", result.risk_flags);
  return;
}

if (result.verdict === "CAUTION") {
  console.log("Proceed with reduced exposure:", result.risk_flags);
}

// Safe to proceed
console.log(`Protocol rated ${result.trust_grade} — ${result.verdict}`);
```

### Pre-Transaction Safety Pattern

The recommended pattern for any agent making onchain transactions:

```javascript
async function safeTransaction(targetContract, tokenAddress, counterpartyWallet) {
  // Single call covers everything
  const url = new URL("https://sentinel-awms.onrender.com/preflight");
  url.searchParams.set("target", targetContract);
  url.searchParams.set("chain", "base");
  url.searchParams.set("detail", "standard");
  if (tokenAddress) url.searchParams.set("token", tokenAddress);
  if (counterpartyWallet) url.searchParams.set("counterparty", counterpartyWallet);

  const result = await x402Fetch(url.toString());
  const assessment = await result.json();

  if (!assessment.proceed) {
    throw new Error(`Sentinel blocked: ${assessment.proceed_recommendation}`);
  }

  if (assessment.trust_grade === "C" || assessment.trust_grade === "D") {
    // Log caution but allow with reduced size
    console.warn("Sentinel caution:", assessment.risk_flags);
    return { proceed: true, reduceExposure: true, flags: assessment.risk_flags };
  }

  return { proceed: true, reduceExposure: false };
}
```

### ElizaOS Plugin

```javascript
// In your ElizaOS agent action:
const sentinelCheck = {
  name: "SENTINEL_VERIFY",
  description: "Verify a protocol before interacting",
  handler: async (runtime, message, state) => {
    const address = extractAddress(message.content);
    const response = await runtime.x402Client.get(
      `https://sentinel-awms.onrender.com/verify/protocol?address=${address}&chain=base&detail=standard`
    );
    return `Protocol ${address}: ${response.trust_grade} (${response.verdict}). ${response.risk_flags?.join(". ") || "No flags."}`;
  },
};
```

---

## Pricing

| Endpoint | Price per call |
|----------|---------------|
| /verify/protocol | $0.008 USDC |
| /verify/token | $0.005 USDC |
| /verify/position | $0.005 USDC |
| /verify/counterparty | $0.010 USDC |
| /preflight | $0.025 USDC |
| /health | Free |

All payments in USDC on Base via x402 protocol.

---

## Caching

Results are cached for 5–15 minutes depending on the endpoint. Repeated queries for the same address return cached results with `cache_hit: true` in the response metadata. This means sub-50ms responses on cache hits.

---

## Network

- **Chain:** Base (mainnet)
- **Payment asset:** USDC
- **Protocol:** x402
- **Facilitator:** Coinbase production facilitator

---

## Questions?

sentinel@dosomethingcollective.com
