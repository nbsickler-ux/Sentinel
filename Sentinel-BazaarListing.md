# Sentinel — Bazaar Listing

## Service Name
Sentinel

## Tagline
The trust layer for autonomous agents. Verify before you execute.

## Short Description (for discovery cards)
Real-time trust verification for any smart contract, token, or wallet address. Pay per call in USDC. No API keys, no accounts — just x402.

## Full Description

### What Sentinel Does
Sentinel answers the most important question an autonomous agent faces before every onchain interaction: **is this safe?**

Submit any contract address, token, or wallet, and Sentinel returns a structured trust assessment — a letter grade (A–F), a trust score (0–100), and detailed evidence across multiple risk dimensions. Your agent gets a clear verdict: SAFE, LOW_RISK, CAUTION, HIGH_RISK, or DANGER.

No accounts. No API keys. No subscriptions. Just call the endpoint and pay per request via x402.

### Endpoints

**`GET /verify/protocol`** — $0.008 USDC
Trust assessment for any smart contract or protocol. Returns audit status, exploit history, contract maturity, TVL stability, governance risk, and community signal — all scored and weighted into a single trust grade.

**`GET /verify/position`** — $0.005 USDC
Risk analysis for an agent's onchain positions. Liquidation proximity, concentration exposure, yield sustainability, and volatility risk.

**`GET /verify/token`** — $0.005 USDC
Token legitimacy check. Honeypot detection, liquidity depth, holder concentration, and rug risk indicators.

**`GET /verify/counterparty`** — $0.01 USDC
Wallet address reputation. Sanctions screening, exploit association, transaction pattern analysis, and behavioral scoring.

**`GET /preflight`** — $0.025 USDC
The comprehensive pre-transaction safety check. Combines protocol, counterparty, and position analysis in a single call. One request, complete coverage.

**`GET /health`** — Free
Service status, current pricing, and endpoint availability.

### Why Agents Choose Sentinel

- **Sub-200ms response times** — fast enough for real-time transaction decisions
- **x402-native** — zero friction, no accounts, no API key management
- **Structured verdicts** — not raw data, but interpreted intelligence with clear action guidance
- **Multi-dimensional scoring** — six risk dimensions per assessment, not a single opaque number
- **Evidence-backed** — every verdict includes the underlying data so agents can make informed decisions
- **Cheap insurance** — $0.008 to verify a protocol vs. potentially thousands lost to an exploit

### Trust Verdict Scale

| Verdict | Grade | What It Means |
|---------|-------|---------------|
| SAFE | A | Proceed — no elevated risk detected |
| LOW_RISK | B | Proceed — minor flags noted |
| CAUTION | C | Reduce exposure — notable risks present |
| HIGH_RISK | D | Human review recommended |
| DANGER | F | Do not proceed — critical risk detected |

### Example Usage

```
GET /verify/protocol?address=0xa238Dd80C259a72e81d7e4664a9801593F98d1c5&chain=base
```

Returns a full trust assessment including audit status (audited by OpenZeppelin, Trail of Bits, SigmaPrime), exploit history (clean), contract maturity (400+ days, verified source, multisig owner), TVL stability, and an overall trust grade.

### Pricing Philosophy
Verification should be so cheap that agents call it on every interaction without hesitation. A $0.008 check that prevents interaction with an exploited contract is infinitely valuable.

### Network
Base (USDC payments via x402 protocol)

## Tags
trust, verification, security, defi, smart-contract, audit, risk, x402, agents, base, usdc, protocol-safety, counterparty, compliance

## Category
Security & Verification

## Contact
sentinel@dosomethingcollective.com
