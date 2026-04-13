# Sentinel Debugging Session — April 13, 2026

## Context

Sentinel is a live trust verification API for autonomous AI agents, built on Node.js/Express and deployed on Render. It's part of the x402 pay-per-call ecosystem on Base L2 — callers pay in USDC per verification call. It uses Upstash Redis, Alchemy, GoPlus, Etherscan, and DeFiLlama as data sources. The codebase lives at `~/Documents/Sentinel` and deploys from `main` on GitHub (`nbsickler-ux/Sentinel`).

## The Problem

Every POST endpoint was returning 400 for 100% of calls. Stats at session start:
- 2,712 total requests, 141 unique callers, $0 revenue
- /verify/token POST: 553 calls, 0 successes, 417 errors
- All POST endpoints (/verify/protocol, /verify/position, /verify/counterparty, /preflight) showed the same pattern
- Error message on every call: `"Missing required field 'address'."`
- Discovery endpoints (/.well-known/x402, /openapi.json) worked fine

## Root Cause Analysis — Three Bugs Found

### Bug 1: Body rescue middleware was a no-op (server.js ~line 100)

`express.json()` silently skips body parsing when `Content-Type` is missing or wrong (e.g., `text/plain`), leaving `req.body` as `undefined`. A "body rescue" middleware existed to handle this case but had an empty `if` block — it detected the problem then did literally nothing. x402 ecosystem callers sending JSON without the correct Content-Type header were silently dropped.

**Fix:** Replaced with `express.raw({ type: () => true, limit: "1mb" })` as a catch-all parser, followed by a middleware that attempts `JSON.parse()` on any Buffer body. This covers callers with missing, wrong, or unusual Content-Type headers.

### Bug 2 (THE KILLER): Normalization middleware used `req.path` which is always `/` (server.js ~line 1617)

The input normalization middleware was mounted with `app.use(NORMALIZE_PATHS, handler)` where `NORMALIZE_PATHS = ["/verify/protocol", "/verify/token", ...]`. When Express mounts middleware this way, it strips the mount path from `req.path`. So inside that handler, `req.path` is always `/`, never `/verify/token`.

Every alias resolution condition like `if (req.path === "/verify/token")` was **always false**. This meant all field name aliases (tokenAddress → address, contractAddress → address, etc.) were completely dead — silently broken since the middleware was added.

**Fix:** Changed all path checks to use `req.baseUrl` instead of `req.path`. `req.baseUrl` preserves the original matched mount path.

### Bug 3: `"token"` was missing from ADDRESS_ALIASES (server.js ~line 1591)

The comment documenting the aliases listed `token (when string & looks like address)` as a supported alias, but it was not in the actual `ADDRESS_ALIASES` array. Callers naturally sending `{"token": "0x..."}` to an endpoint called `/verify/token` would always fail.

**Fix:** Added `"token"` and `"addr"` to the ADDRESS_ALIASES array.

### Bonus fix: Diagnostic 400 logger had the same `req.path` bug

The diagnostic logger (mounted with the same `app.use(NORMALIZE_PATHS, ...)` pattern) was logging `req.path` which was always `/`, making it impossible to see which endpoint was actually failing. Fixed to use `req.baseUrl`.

## What Was Deployed

All fixes in a single commit on `main`:
```
fix: resolve 100% POST failure on all verify endpoints
```
Commit hash: `45723d2`. Pushed to GitHub, auto-deployed on Render. Verified live at ~14:23 UTC with three test calls from Chrome, all returning status 200 with verdict "SAFE".

## Live Verification Results

Three tests run against production immediately after deploy:

1. **Standard POST** (correct Content-Type + `address` field) → 200, SAFE, grade A
2. **POST without Content-Type** (body rescue fix) → 200, SAFE, grade A
3. **POST with alias `token` instead of `address`** (normalization + alias fix) → 200, SAFE, grade A

## Caller Analysis — Bots vs Real Users

After fixing the endpoints, we analyzed the full stats to answer: how many of the 141 "unique callers" are real?

### The April 4 spike was an indexing event

1,184 of 2,717 total requests (44%) came on a single day — April 4. This is when Sentinel got listed in the x402 registry. Top callers from that day are AWS IPs that blasted through in seconds:
- 13.223.76.50: 162 requests in 4 minutes
- 98.81.23.80: 29 requests in 2 seconds
- 100.31.55.123: 26 requests in 1 second

These are x402scan validators and ecosystem crawlers mapping the API surface. They hit every endpoint with GET/HEAD/POST/OPTIONS/DELETE to index capabilities. None have returned. This cluster accounts for ~10-15 callers and ~1,000+ requests.

### Caller breakdown

- **~100+ callers**: Single-visit crawlers (mostly from April 4 indexing event), never returned
- **~1 caller**: Localhost (::1) — Nate's own testing on April 1-2, 209 requests
- **~3-5 callers**: Discovery pollers — only hit /openapi.json and /.well-known/x402 on a schedule (e.g., 79.137.72.94 every ~4 hours for 13 days). Registry crawlers keeping indexes fresh. Never tried to actually call a verify endpoint.
- **~5-8 callers**: Persistent monitors — HEAD/GET probes to verify endpoints, checking availability before escalating to paid POST calls. Includes 89.116.32.103 and 23.106.143.171 (both active 9+ days).
- **~3-5 callers with genuine usage intent**:

### Callers that look like real prospects

**34.158.104.72 (Google Cloud)** — The strongest signal. 213 requests over 9 days. POSTs to /verify/token every ~90 minutes. Every call returned 400. This is an automated agent with Sentinel configured as a data source in what appears to be a production loop. Still calling as of 14:26 UTC today — it will hit the fixed endpoint on its next cycle.

**130.162.210.47 (Oracle Cloud)** — 79 requests over 8 days. Persistent GET requests to /verify/token every ~2.5 hours. Same pattern: keeps trying, keeps failing.

**45.23.251.54** — 192 requests over 8 days. Persistently active.

**93.34.148.134** — 115 requests in a single day (April 12). Heavy usage burst suggesting active integration testing.

### Bottom line

Real prospects with demonstrated usage intent: approximately **5-8 callers**. But they're persistent — they already integrated Sentinel into their pipelines and have been faithfully retrying despite 100% failure. Now that the bugs are fixed, they should start succeeding without any action needed.

## Files Changed

Only `server.js` was modified. No new files, no dependency changes.

## What to Watch

1. **34.158.104.72** should flip from 400 to 200 within ~90 minutes of deploy (around 15:55 UTC). Check /admin/stats for the first organic success.
2. Revenue should remain $0 short-term since all current callers are within free tier (25 calls/day/IP). Revenue begins when a caller exceeds the free tier quota.
3. The diagnostic 400 logger now correctly reports the endpoint path, so future validation failures will be much easier to debug.
4. Consider adding `user_agent` to the request_log table — it would help distinguish agent frameworks from generic HTTP clients in future analysis.
