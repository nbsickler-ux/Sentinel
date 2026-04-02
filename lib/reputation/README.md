# Agent Reputation Registry

Tracks how agents interact with Sentinel over time. Returning agents with good history get faster verification through extended cache TTLs and reduced OFAC re-screening.

## Tiers

| Tier | Criteria | Benefits |
|------|----------|----------|
| **UNKNOWN** | Default | Full verification depth (current behavior) |
| **RECOGNIZED** | 5+ verifications, 0 flags | Extended cache TTLs, OFAC skip if <24h |
| **TRUSTED** | 20+ verifications, 5+ in 30d, 0 flags | Further extended TTLs, OFAC skip if <48h |

## Key Design Decisions

- Reputation NEVER skips the scoring engine — only adjusts cache TTLs and OFAC frequency
- Reputation applies to the **agent**, not the **target** — a trusted agent hitting a suspicious contract gets full scrutiny
- Profiles stored in Redis with no TTL (persist indefinitely)
- If Redis is lost, agents restart as UNKNOWN — acceptable degradation
- Forward-compatible with ERC-8004 (Agent Trust Protocol) via reserved metadata fields

## API

- `GET /agent/:walletAddress` — Public profile (tier, total verifications, first seen)
- All paid endpoint responses include `meta.agent_tier` showing the caller's tier
