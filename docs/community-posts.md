# Sentinel — Developer Community Posts

*Internal reference — three channel-specific posts for ecosystem visibility.*

---

## 1. x402 Discord

**Channel:** #showcase or #builders (wherever community projects are shared)

---

Hey all — sharing an update on Sentinel, the trust verification layer for autonomous agents on Base.

**Sentinel** is x402-native — agents pay per query in USDC, no API keys or accounts needed. Every verification now creates an on-chain EAS attestation on Base, building a permanent trust record for the ecosystem.

What's live:

- `/verify/protocol` ($0.008) — smart contract trustworthiness (audits, TVL, exploit history, contract maturity)
- `/verify/token` ($0.005) — token legitimacy (honeypot detection, tax manipulation, rugpull patterns)
- `/verify/position` ($0.005) — DeFi position safety (liquidity, IL risk, concentration)
- `/verify/counterparty` ($0.010) — wallet safety (OFAC sanctions, exploit association, activity patterns)
- `/preflight` ($0.025) — all of the above in parallel, single go/no-go verdict

New since launch:

- **On-chain EAS attestations** — every paid verification is recorded on Base via the Ethereum Attestation Service. Check existing attestations for free via `GET /attestation/:address`.
- **Agent reputation tiers** — agents that verify consistently earn trust tiers (Unknown → Recognized → Trusted) with faster cache windows. Check any agent's standing via `GET /agent/:wallet`.
- **Monitoring webhooks** — subscribe to `POST /watch` ($0.05) and get alerts when a target's risk profile changes. Background scanner runs every 30 minutes.
- **Compliance audit trail** — all verifications logged to Postgres with daily reports.

Schema on Base: `0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04`

Data comes from GoPlus, DeFiLlama (2,800+ Base protocol addresses), Etherscan V2, Alchemy, and the OFAC SDN list. Responses include a confidence score reflecting data source coverage.

Live at: https://sentinel-awms.onrender.com
Spec: https://sentinel-awms.onrender.com/openapi.json
GitHub: https://github.com/nbsickler-ux/Sentinel

Would love feedback from anyone building agents with x402. Especially interested in how the attestation records and reputation tiers could integrate with other x402 services.

---

## 2. Base Ecosystem / Builder Channels

**Channel:** Base Discord #builders, Farcaster /base, or relevant Base ecosystem threads

---

Sharing an update on a project built on Base: **Sentinel** — trust infrastructure for autonomous AI agents.

The problem: agents are starting to move money on-chain autonomously. But there's no standard way for an agent to check whether a contract, token, wallet, or position is safe *before* executing. Sentinel answers that question — and now records every answer as a permanent on-chain attestation.

It runs on x402 — agents pay per query in USDC on Base. No API keys, no accounts. Just POST a request, pay via x402, get a trust verdict back.

**What it checks:**
- Protocol trust — audit status, TVL health, exploit history, contract age, governance
- Token safety — honeypot detection, tax manipulation, ownership concentration
- Counterparty risk — OFAC sanctions screening, contract verification, activity signals
- Position risk — protocol trust + category-specific risk factors
- Preflight — runs everything in parallel, returns a single proceed/don't-proceed recommendation

**What's new:**
- Every verification creates an on-chain EAS attestation on Base — permanent, independently verifiable trust records
- Agent reputation system — returning agents earn trust tiers for faster, cheaper service
- Monitoring webhooks — subscribe and get proactive alerts when a watched address's risk changes
- Compliance audit trail with daily reports

All data is sourced in real time from GoPlus, DeFiLlama, Etherscan, and Alchemy. The OFAC SDN list is loaded at startup for sanctions screening. The EAS schema is live on Base mainnet.

Built natively on Base with the Coinbase CDP facilitator.

Live: https://sentinel-awms.onrender.com
OpenAPI spec: https://sentinel-awms.onrender.com/openapi.json
EAS Schema: https://base.easscan.org/schema/view/0xa756c7bbd2cb557265f84698ee0502f4fe118cd12ce409a8970afbd09b7e6d04

If you're building agents that interact with contracts on Base, the preflight endpoint is designed to slot directly into your agent's decision loop as a pre-execution check — and every check builds the on-chain trust record.

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

**New capabilities:**
- **On-chain attestations** — every verification creates an EAS attestation on Base. Check existing attestations for free before paying via `GET /attestation/:address`.
- **Agent reputation** — your agent builds a trust profile over time. 5+ verifications = Recognized tier, 20+ = Trusted tier with extended cache windows.
- **Monitoring** — subscribe to `POST /watch` for webhook alerts when a target's risk profile changes.

The response includes a confidence score (0.0–1.0) so your agent knows how much data backed the assessment, plus specific risk flags it can reason about.

Spec: https://sentinel-awms.onrender.com/openapi.json
Live: https://sentinel-awms.onrender.com
GitHub: https://github.com/nbsickler-ux/Sentinel

Designed for the pattern where your agent needs to verify before it executes. Every check builds your agent's reputation and creates a permanent trust record. Happy to discuss integration approaches if anyone's working on this.
