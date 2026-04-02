# Compliance Audit Trail

Structured verification records in Postgres for regulatory compliance, dispute resolution, and analytics.

## What's Recorded

Every paid verification writes: agent identity, target address, verdict, score, grade, risk flags, response time, cache status, payment amount, data sources used, and degraded sources.

## Admin Endpoints

- `GET /admin/audit` — Query records with filters (agent, target, verdict, date range)
- `GET /admin/audit/summary` — Aggregate stats (by verdict, endpoint, tier, performance)

Both require `Authorization: Bearer <SENTINEL_ADMIN_KEY>`.

## Daily Reports

Auto-generated daily summaries stored in `daily_reports` table. One row per day with aggregate metrics.
