# Monitoring Webhooks

Proactive risk monitoring: agents subscribe to targets and get notified when risk profiles change.

## Flow

1. Agent subscribes via `POST /watch` (requires RECOGNIZED+ tier, $0.05)
2. Background scanner re-checks watched addresses every 6 hours
3. On significant change (verdict change, >15pt score shift, critical flag), webhooks fire to all subscribers
4. Subscriptions auto-expire after 30 days

## Limits

- Max 100 total watched addresses (caps background API usage to ~3,200 calls/day)
- Max 10 watches per agent
- Only RECOGNIZED/TRUSTED agents can subscribe

## Change Detection

A "significant change" is: verdict change, 15+ point score shift, or new critical flag (SANCTIONED, EXPLOIT_VICTIM, HONEYPOT, RUG_PULL).
