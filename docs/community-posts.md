# Sentinel — Developer Community Posts

*Internal reference — three channel-specific posts for ecosystem visibility.*

---

## 1. x402 Discord

**Channel:** #showcase or #builders (wherever community projects are shared)

---

Hey all — built something on x402 I wanted to share.

**Sentinel** is a trust verification layer for autonomous agents on Base. It's x402-native — agents pay per query in USDC, no API keys or accounts needed.

Five endpoints, all live on mainnet:

- `/verify/protocol` ($0.008) — smart contract trustworthiness (audits, TVL, exploit history, contract maturity)
- `/verify/token` ($0.005) — token legitimacy (honeypot detection, tax manipulation, rugpull patterns)
- `/verify/position` ($0.005) — DeFi position safety (liquidity, IL risk, concentration)
- `/verify/counterparty` ($0.010) — wallet safety (OFAC sanctions, exploit association, activity patterns)
- `/preflight` ($0.025) — all of the above in parallel, single go/no-go verdict

The idea is simple: before an agent executes any on-chain action, it calls Sentinel to check if the interaction is safe. The preflight endpoint is designed to be the last step before `executeTransaction()`.

Uses the Bazaar discovery extension with full input/output schemas, so it's indexed and discoverable. OpenAPI 3.1 spec at `/openapi.json` and `.well-known/x402` discovery doc are both live.

Data comes from GoPlus, DeFiLlama (2,800+ Base protocol addresses), Etherscan V2, Alchemy, and the OFAC SDN list. Responses include a confidence score reflecting data source coverage.

Live at: https://sentinel-awms.onrender.com
Spec: https://sentinel-awms.onrender.com/openapi.json
GitHub: https://github.com/nbsickler-ux/Sentinel

Would love feedback from anyone building agents with x402. The scoring model is designed to be opinionated but transparent about what it checks — happy to discuss the approach.

---

## 2. Base Ecosystem / Builder Channels

**Channel:** Base Discord #builders, Farcaster /base, or relevant Base ecosystem threads

---

Sharing a project built on Base: **Sentinel** — a real-time trust verification API for autonomous AI agents.

The problem: agents are starting to move money on-chain autonomously. But there's no standard way for an agent to check whether a contract, token, wallet, or position is safe *before* executing. Sentinel answers that question.

It runs on x402 — agents pay per query in USDC on Base. No API keys, no accounts. Just POST a request, pay via x402, get a trust verdict back.

**What it checks:**
- Protocol trust — audit status, TVL health, exploit history, contract age, governance
- Token safety — honeypot detection, tax manipulation, ownership concentration
- Counterparty risk — OFAC sanctions screening, contract verification, activity signals
- Position risk — protocol trust + category-specific risk factors
- Preflight — runs everything in parallel, returns a single proceed/don't-proceed recommendation

All data is sourced in real time from GoPlus, DeFiLlama, Etherscan, and Alchemy. The OFAC SDN list is loaded at startup for sanctions screening.

Built natively on Base mainnet with the Coinbase CDP facilitator. First paid transaction already settled on-chain.

Live: https://sentinel-awms.onrender.com
OpenAPI spec: https://sentinel-awms.onrender.com/openapi.json

If you're building agents that interact with contracts on Base, the preflight endpoint is designed to slot directly into your agent's decision loop as a pre-execution check.

---

## 3. AgentKit / AI Agent Builder Communities

**Channel:** AgentKit Discord, AI agent builder forums, or relevant LangChain/CrewAI/ElizaOS channels

---

If you're building autonomous agents that execute on-chain, there's a trust verification layer you might find useful.

**Sentinel** is an API that answers one question before your agent executes a transaction: *is this safe?*

It sits between your agent's decision logic and the actual on-chain execution. Your agent calls `/preflight` with the target contract address, and Sentinel runs protocol verification, token safety checks, counterparty screening (including OFAC sanctions), and position risk analysis in parallel — then returns a single `proceed: true/false` with a trust grade and verdict.

**Integration is stateless:**
```
POST /preflight { "target": "0x...", "chain": "base" }
→ { "proceed": true, "verdict": "SAFE", "trust_grade": "A", "composite_score": 87 }
```

Payment is handled via x402 — your agent pays $0.025 USDC on Base per preflight check. If you're using AgentKit, x402-axios, or any x402-compatible client, payment negotiation happens automatically.

Individual checks are also available if you only need one dimension:
- `/verify/protocol` — $0.008
- `/verify/token` — $0.005
- `/verify/position` — $0.005
- `/verify/counterparty` — $0.010

The response includes a confidence score (0.0–1.0) so your agent knows how much data backed the assessment, plus specific risk flags it can reason about.

Spec: https://sentinel-awms.onrender.com/openapi.json
Live: https://sentinel-awms.onrender.com

Designed for the pattern where your agent needs to verify before it executes. Happy to discuss integration approaches if anyone's working on this.
