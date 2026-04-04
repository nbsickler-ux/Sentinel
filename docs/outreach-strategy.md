# Sentinel Direct Outreach Strategy

## Outreach Template

Subject: "Free trust verification for your Base agent — 25 calls/day, no signup"

---

Hey [name],

I built Sentinel — a trust verification API for autonomous agents on Base. Before your agent swaps a token or enters a DeFi position, Sentinel tells it whether it's safe (honeypot detection, sanctions screening, protocol audits, the whole stack).

It's live now with a free tier: 25 calls/day, no wallet, no signup, no API keys. Just POST JSON and get a trust verdict back.

Quick example:
```
curl -X POST https://sentinel-awms.onrender.com/verify/token \
  -H "Content-Type: application/json" \
  -d '{"address": "0x...", "chain": "base"}'
```

Every verification also creates an on-chain EAS attestation on Base — permanent, verifiable trust records.

I saw [specific thing about their project] and thought this could slot directly into [specific integration point]. Happy to jump on a call or just answer questions async.

Integration guide: https://github.com/nbsickler-ux/Sentinel/blob/main/INTEGRATION.md

— Nate

---

## Target Projects (Priority Order)

### Tier 1 — Highest alignment, reach out this week

**1. Yield Seeker** (yieldseeker.xyz)
- AI agents managing stablecoin yields across Aave, Morpho, Spark on Base
- AgentKit grantee — direct Coinbase connection
- Hook: "Your agents are managing user capital autonomously — Sentinel verifies every protocol they interact with before committing funds"

**2. Giza ARMA** (giza.ai)
- Autonomous yield optimization, multi-protocol rebalancing on Base
- Launched mainnet Jan 2025
- Hook: "ARMA makes automated capital allocation decisions — Sentinel adds an independent trust check before each rebalance"

**3. Theoriq AlphaSwarm** (theoriq.ai)
- Multi-agent infrastructure for DeFi workflows
- Agent-to-agent interaction patterns
- Hook: "When agents interact with each other, how does each agent know the other is legitimate? Sentinel provides verifiable trust scores"

### Tier 2 — Large user base, reach out within 2 weeks

**4. Griffin AI** (griffinai.io)
- 15,000+ live agents, no-code builder
- Transaction Execution Agent does real trades
- Hook: "With 15K agents executing trades, adding a trust verification layer protects your users and differentiates your platform"

**5. Almanak** (almanak.co)
- Institutional DeFi trading SDK, $8.45M Series A
- Python SDK with 29 built-in tools
- Hook: "For institutional clients, trust verification isn't optional — Sentinel gives your agents an auditable safety check before every execution"

### Tier 3 — Ecosystem plays, reach out within 3 weeks

**6. World AgentKit** (world.org)
- Human identity verification for agents via World ID
- Complementary trust stack — they verify identity, we verify behavior
- Hook: "World ID proves a human is behind the agent. Sentinel proves the agent's transactions are safe. Together = complete trust stack"
- NOTE: x402 whitepaper coauthor liked Nate's post — warm lead, approach carefully

**7. erdGeclaw plugin-base-signals** (GitHub)
- ElizaOS whale tracking plugin for Base
- Already uses GoPlus for basic token safety
- Hook: "You're already doing token safety scoring — Sentinel provides a more comprehensive trust assessment with on-chain attestations"

**8. Nirholas Agenti** (GitHub)
- MCP server giving AI agents money across 20+ chains
- x402-enabled, open source
- Hook: "Your agents are moving capital across chains — Sentinel verifies the destination before the money moves"

### Tier 4 — Emerging projects, monitor and engage

**9. Trix-AI** — Natural language DeFi agent (CoW Swap integration)
**10. HydrEx + Moltbot** — Base DEX with Farcaster mini-app agents
**11. DeFi Agents AI** — Autonomous trading agents

---

## x402 Whitepaper Coauthor (Warm Lead)

One of the x402 whitepaper coauthors liked Nate's Sentinel post. This is the most valuable connection we have right now.

**Approach:**
- Do NOT lead with a pitch
- Engage with their content first (like, thoughtful replies)
- After 2-3 genuine interactions, DM: "Hey, I noticed you liked the Sentinel post. We're building the trust verification layer for x402 agents on Base — would love to get your thoughts on the approach"
- Goal: Get feedback, not a sale. If they see value, they'll amplify organically

**Timeline:** Start engaging this week, DM in ~7 days

---

## Metrics to Track

- Outreach sent (target: 10 this week)
- Responses received
- Integration conversations started
- Free tier activations from outreach
- First external verification call (the real milestone)
