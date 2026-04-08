# Sentinel — Developer Community Posts

*Internal reference — three channel-specific posts for ecosystem visibility.*

---

## 1. x402 Discord

**Channel:** #showcase or #builders (wherever community projects are shared)

---

Hey all — I built something I think this community will find useful.

**Sentinel** is a trust verification layer for autonomous agents, built natively on x402. Agents pay per query in USDC on Base — no API keys, no accounts, no pre-registration. Just a standard x402 payment flow.

The problem it solves: agents are starting to move money on-chain autonomously, but there's no standard pre-execution check for whether a contract, token, or wallet is safe. Sentinel sits in the agent's decision loop and answers that question before anything executes.

**What it checks:**

- `/verify/protocol` ($0.008) — smart contract trustworthiness (audits, TVL, exploit history, contract maturity)
- `/verify/token` ($0.005) — token legitimacy (honeypot detection, tax manipulation, rugpull patterns)
- `/verify/position` ($0.005) — DeFi position safety (liquidity, IL risk, concentration)
- `/verify/counterparty` ($0.010) — wallet safety (OFAC sanctions, exploit association, activity patterns)
- `/preflight` ($0.025) — all of the above in parallel, single go/no-go verdict

**What makes it different:**

- **On-chain EAS attestations** — every paid verification is recorded permanently on Base via the Ethereum Attestation Service. Other agents can check existing attestations for free via `GET /attestation/:address` before paying for a fresh check.
- **Agent reputation tiers** — agents that verify consistently build trust (Unknown → Recognized → Trusted) with faster cache windows at each tier. Check any agent's standing via `GET /agent/:wallet`.
- **Monitoring webhooks** — subscribe via `POST /watch` ($0.05) and get proactive alerts when a target's risk profile changes. Background scanner runs every 30 minutes.
- **Compliance audit trail** — all verifications logged with daily reports.

Data sources: GoPlus, DeFiLlama (2,800+ Base protocol addresses), Etherscan V2, Alchemy, and the OFAC SDN list. Every response includes a confidence score reflecting how much data backed the assessment.

EAS Schema on Base: `0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04`

Live: https://sentinel-awms.onrender.com
OpenAPI spec: https://sentinel-awms.onrender.com/openapi.json
GitHub: https://github.com/nbsickler-ux/Sentinel

Would love feedback from anyone building agents with x402 — especially interested in what trust data would be most useful in your agent's decision loop.

---

## 2. Base Ecosystem / Builder Channels

**Channel:** Base Discord #builders, Farcaster /base, or relevant Base ecosystem threads

---

Sharing something I've been building on Base: **Sentinel** — trust infrastructure for autonomous AI agents.

The problem: agents are starting to move money on-chain autonomously. But there's no standard way for an agent to check whether a contract, token, wallet, or position is safe *before* executing. Sentinel sits in the agent's decision loop and answers that question — then records every answer as a permanent on-chain attestation on Base.

It runs on x402 — agents pay per query in USDC on Base. No API keys, no accounts. Just POST a request, pay via x402, get a trust verdict back. Built natively on Base with the Coinbase CDP facilitator.

**What it checks:**
- Protocol trust — audit status, TVL health, exploit history, contract age, governance
- Token safety — honeypot detection, tax manipulation, ownership concentration
- Counterparty risk — OFAC sanctions screening, contract verification, activity signals
- Position risk — protocol trust + category-specific risk factors
- Preflight — runs everything in parallel, returns a single proceed/don't-proceed recommendation

**Key capabilities:**
- Every verification creates an on-chain EAS attestation on Base — permanent, independently verifiable trust records that any agent can reference
- Agent reputation system — agents build trust tiers over time (Unknown → Recognized → Trusted) with faster cache windows at each level
- Monitoring webhooks — subscribe and get proactive alerts when a watched address's risk profile changes
- Compliance audit trail with daily reports

All data is sourced in real time from GoPlus, DeFiLlama (2,800+ Base protocol addresses), Etherscan V2, Alchemy, and the OFAC SDN list. The EAS schema is live on Base mainnet.

Live: https://sentinel-awms.onrender.com
OpenAPI spec: https://sentinel-awms.onrender.com/openapi.json
EAS Schema: https://base.easscan.org/schema/view/0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04
GitHub: https://github.com/nbsickler-ux/Sentinel

If you're building agents that interact with contracts on Base, the `/preflight` endpoint is designed to slot directly into your agent's decision loop as a pre-execution check. Feedback welcome — especially on what trust dimensions matter most for your use case.

---

## 3. AgentKit / AI Agent Builder Communities

**Channel:** AgentKit Discord, AI agent builder forums, or relevant LangChain/CrewAI/ElizaOS channels

---

If you're building autonomous agents that execute on-chain, there's trust infrastructure you might find useful.

**Sentinel** answers one question before your agent executes a transaction: *is this safe?* — and records the answer as a permanent on-chain attestation on Base.

It sits between your agent's decision logic and the actual on-chain execution. Your agent calls `/preflight` with the target contract address, and Sentinel runs protocol verification, token safety checks, counterparty screening (including OFAC sanctions), and position risk analysis in parallel — then returns a single `proceed: true/false` with a trust grade and verdict.

**Integration is stateless:**
```
POST /preflight { "target": "0x...", "chain": "base" }
→ { "proceed": true, "verdict": "SAFE", "trust_grade": "A", "composite_score": 87 }
→ EAS attestation written to Base (async)
```

Payment is handled via x402 — your agent pays $0.025 USDC on Base per preflight check. If you're using AgentKit, x402-axios, or any x402-compatible client, payment negotiation happens automatically.

Individual checks are also available if you only need one dimension:
- `/verify/protocol` — $0.008
- `/verify/token` — $0.005
- `/verify/position` — $0.005
- `/verify/counterparty` — $0.010

**Beyond verification:**
- **On-chain attestations** — every verification creates an EAS attestation on Base. Check existing attestations for free before paying via `GET /attestation/:address`.
- **Agent reputation** — your agent builds a trust profile over time. 5+ verifications = Recognized tier, 20+ = Trusted tier with extended cache windows.
- **Monitoring** — subscribe to `POST /watch` for webhook alerts when a target's risk profile changes.

The response includes a confidence score (0.0–1.0) so your agent knows how much data backed the assessment, plus specific risk flags it can reason about.

Spec: https://sentinel-awms.onrender.com/openapi.json
Live: https://sentinel-awms.onrender.com
GitHub: https://github.com/nbsickler-ux/Sentinel

Designed for the pattern where your agent needs to verify before it executes. Every check builds your agent's reputation and creates a permanent trust record. Happy to discuss integration approaches if anyone's working on this.
