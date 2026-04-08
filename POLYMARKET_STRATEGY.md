# Polymarket Prediction Agent: Strategy & Build Plan

**Date:** April 7, 2026
**Status:** Research complete → Ready to build
**Priority:** HIGH — move fast, first-mover advantage in AI-agent prediction trading

---

## 1. Honest Assessment: What's Real vs. Hype

### What's Real
- Polymarket is the dominant prediction market (~$500M+ monthly volume)
- 30%+ of wallets already use AI agents (LayerHub data)
- AI agents outperform humans: 37% of bots are profitable vs ~8% of human traders
- Polystrat agent executed 4,200+ trades in one month with returns up to 376% on individual positions
- The CLOB API is mature, well-documented, with official TypeScript/Python/Rust clients
- US access is live (CFTC-approved, invite-only, sports markets)
- Maker orders are FREE (0% fee). US taker fee is 0.30% with 0.20% maker rebate
- Gas is effectively zero (Polygon, subsidized by Polymarket)

### What's Hype
- The "$3.3M in profits" claim (sovereign2013) — partially verified but primarily sports arbitrage at scale. 92.4% of wallets lose money. Survivorship bias is extreme.
- "Easy money" narratives — latency arbitrage windows compressed to ~4 seconds, dominated by dedicated infra
- Assumption that any AI agent automatically profits — most lose. The edge has to be specific and defensible.

### Realistic Revenue Targets
- **Conservative (months 1-3):** Break-even to small profit while validating edge. Target: recoup costs.
- **Moderate (months 3-6):** $500-2,000/month if information edge validates. Requires $5K-10K capital.
- **Ambitious (months 6-12):** $2,000-10,000/month at $20K-50K deployed capital with proven strategy.
- **The $1-3M claim:** Requires $500K+ capital, years of compounding, and being in the top 0.1% of operators. Not a near-term target — but the infrastructure we'd build is the same infrastructure those operators use.

---

## 2. US Access Constraints & Path

### Current State (April 2026)
- **App-only trading** — desktop is view-only
- **Sports markets only** — politics, crypto, culture marked "coming soon"
- **Invite codes available:** GOAL, LABS, ELITE, GRINDERS, INSIDER, etc. ($20 deposit match bonus)
- **1M+ person waitlist** — invite codes bypass it
- **API access:** Full CLOB API works for US users on permitted market categories

### Timeline for Broader Markets
- **Q2-Q3 2026:** Additional market categories likely (CFTC has approved elections already)
- **Q3-Q4 2026:** Expected full market access parity with international
- **State-level challenges:** Nevada and others have ongoing legal disputes, but federal CFTC approval supersedes for derivatives

### Implication for Strategy
Start with sports. This is not a limitation — it's an advantage. Sports markets have the highest volume, fastest resolution, and most predictable event schedules. The 0.75% taker fee (or 0.30% regulated US) is the lowest category. And sports is where the $20 bonus capital goes.

---

## 3. Strategy Selection

### Strategies Evaluated

| Strategy | Edge | Feasibility | Capital Req | Competition |
|----------|------|-------------|-------------|-------------|
| Latency Arbitrage | Speed | LOW — 4s windows, infra-heavy | $50K+ | Extreme |
| Cross-Market Arb (Polymarket ↔ Kalshi) | Price gaps | MEDIUM — gaps exist but narrow | $10K+ | High |
| News/Information Edge | Claude processing speed | HIGH — direct reuse of existing pipeline | $2K-5K | Moderate |
| Market Making | Spread capture | MEDIUM — maker rebate helps | $10K+ | High |
| Overreaction Fading | Mean reversion on news | HIGH — Claude can assess magnitude | $2K-5K | Low |
| 5-Min BTC Prediction | High-frequency binary | MEDIUM — existing price data pipeline | $1K-2K | Moderate |

### Primary Strategy: News/Information Edge + Overreaction Fading

**Why this wins:**
1. **We already have the pipeline.** Market Agent's qualitative layer (Claude news synthesis, sentiment scoring, contradiction detection) maps directly to prediction market edge.
2. **Claude processes news faster than humans.** The 37% bot profitability rate comes primarily from information processing speed, not from better models.
3. **Sports events generate predictable news flows.** Injury reports, lineup changes, weather, referee assignments — all move prediction market odds, often with a delay.
4. **Maker orders are free.** We place limit orders at our fair value and wait for the market to come to us. Zero taker fees + 0.20% rebate.
5. **Overreaction fading compounds the edge.** When news breaks and the market overreacts (star player "questionable" → odds crash), we fade the move.

### Secondary Strategy: 5-Minute BTC Prediction Markets

If/when crypto markets open for US users, the 5-minute BTC prediction markets are a natural extension. We already have cbBTC/USDC price feeds, trend/reversion signals, and a Sharpe 4.46 edge on BTC direction. This would be the highest-frequency application.

---

## 4. Technical Architecture

### System Overview

```
┌─────────────────────────────────────────────────┐
│                POLYMARKET AGENT                   │
│                                                   │
│  ┌───────────┐  ┌───────────┐  ┌──────────────┐ │
│  │  News      │  │  Odds     │  │  Event       │ │
│  │  Ingest    │  │  Monitor  │  │  Calendar    │ │
│  └─────┬─────┘  └─────┬─────┘  └──────┬───────┘ │
│        │              │               │          │
│        ▼              ▼               ▼          │
│  ┌─────────────────────────────────────────────┐ │
│  │           Claude Analysis Engine              │ │
│  │  • News relevance scoring                     │ │
│  │  • Fair probability estimation                │ │
│  │  • Overreaction detection                     │ │
│  │  • Contradiction flagging                     │ │
│  └─────────────────────┬───────────────────────┘ │
│                        │                          │
│                        ▼                          │
│  ┌─────────────────────────────────────────────┐ │
│  │           Decision Engine                     │ │
│  │  • Kelly criterion position sizing            │ │
│  │  • Circuit breaker checks                     │ │
│  │  • Portfolio exposure limits                  │ │
│  └─────────────────────┬───────────────────────┘ │
│                        │                          │
│                        ▼                          │
│  ┌─────────────────────────────────────────────┐ │
│  │           Execution Layer                     │ │
│  │  • CLOB limit order placement                 │ │
│  │  • Position monitoring                        │ │
│  │  • Auto-exit on resolution                    │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  ┌─────────────────────────────────────────────┐ │
│  │           Risk & Tracking                     │ │
│  │  • P&L tracking (Postgres)                    │ │
│  │  • Drawdown monitoring                        │ │
│  │  • Human approval gate (Phase 1)              │ │
│  │  • Dashboard                                  │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### What We Reuse from Market Agent

| Component | Reuse Level | Notes |
|-----------|-------------|-------|
| Claude qualitative pipeline | **HIGH** — core prompts adapted | News synthesis, sentiment, contradiction |
| Anthropic SDK integration | **DIRECT** — no changes | Same `@anthropic-ai/sdk` |
| Postgres schema pattern | **HIGH** — extend for predictions | Trades, proposals, metrics |
| Circuit breaker | **HIGH** — same logic | Max positions, drawdown, consecutive losses |
| Human approval gate | **DIRECT** — same pattern | Proposals → approve/reject |
| Dashboard | **MEDIUM** — adapt UI | New metrics for prediction markets |
| Express server | **DIRECT** | Same API pattern |
| Config/logging | **DIRECT** | Same pino + dotenv pattern |
| Redis caching | **DIRECT** | Same Upstash integration |
| News API / Benzinga ingest | **HIGH** — add sports sources | Extend with ESPN, injury feeds |

### New Components to Build

1. **Polymarket Client Wrapper** — Thin layer over `@polymarket/clob-client` for market discovery, odds monitoring, order placement
2. **Sports News Ingest** — ESPN API, official team injury reports, weather APIs for outdoor sports
3. **Fair Value Estimator** — Claude prompt that takes event context + news + current odds and produces probability estimate with confidence
4. **Odds Monitor** — WebSocket/polling loop tracking live odds on active markets, detecting moves
5. **Order Manager** — Places maker limit orders, tracks fills, manages position lifecycle
6. **Event Calendar** — Schedules which markets to monitor and when (game times, resolution times)

### Dependencies (New)

```json
{
  "@polymarket/clob-client": "latest",
  "ethers": "^5.7.0"
}
```

Note: Polymarket client requires ethers v5, not v6. Market Agent uses ethers v6. These will coexist as separate packages or we use a compatibility layer.

### Wallet Setup

- Need a Polygon wallet funded with USDC
- Private key stored in `.env` as `POLYGON_WALLET_PRIVATE_KEY`
- USDC on Polygon (bridge from Base or buy directly)
- Polymarket API credentials (generated from the CLOB client after wallet signature)

---

## 5. Prompt Architecture

### Core Prompt: Fair Value Estimation

The key prompt takes event context and produces a probability estimate. This is the heart of the edge.

```
SYSTEM: You are a sports prediction analyst. You estimate the probability
of outcomes based on available evidence. You must be calibrated — when you
say 60%, the event should happen ~60% of the time. Overconfidence is the
primary failure mode. When uncertain, pull toward 50%.

USER: Estimate the probability for this prediction market:

MARKET: {market_question}
CURRENT ODDS: Yes {yes_price}¢ / No {no_price}¢
RESOLUTION DATE: {end_date}

RELEVANT NEWS (last 24h):
{news_items}

CONTEXT:
- Sport: {sport}
- Teams/Players: {participants}
- Historical data: {historical_context}

Respond JSON only:
{
  "fair_probability": 0.0 to 1.0,
  "confidence": 0.0 to 1.0,
  "edge_vs_market": -0.5 to 0.5,
  "key_factors": ["factor1", "factor2"],
  "news_impact": "positive|negative|neutral|mixed",
  "recommendation": "buy_yes|buy_no|no_trade",
  "rationale": "2-3 sentences"
}
```

### Overreaction Detection Prompt

```
SYSTEM: You detect when prediction markets have overreacted to news.
Markets often move too far on breaking news before settling back.
Your job is to identify these overreactions within minutes of the move.

USER: A prediction market just moved significantly:

MARKET: {market_question}
PRICE BEFORE NEWS: {pre_price}¢
PRICE NOW: {current_price}¢
MOVE: {delta}¢ in {minutes} minutes

THE NEWS THAT CAUSED THE MOVE:
{news_content}

Is this move justified or an overreaction?

Respond JSON only:
{
  "assessment": "justified|overreaction|underreaction",
  "fair_price_estimate": 0 to 100,
  "reversion_expected": true/false,
  "reversion_magnitude": 0 to 50 (cents),
  "time_to_reversion": "minutes|hours|days",
  "confidence": 0.0 to 1.0,
  "rationale": "2-3 sentences"
}
```

### Model Selection

- **Fair value estimation:** Claude Haiku (fast, cheap, high volume — $0.80/M input)
- **Overreaction detection:** Claude Sonnet (needs deeper reasoning — $3/M input)
- **Contradiction/conflict resolution:** Claude Sonnet (same as Market Agent)

Estimated Claude API cost: $5-15/day at active trading volumes (100-300 analyses/day).

---

## 6. Risk Management

### Position Sizing: Fractional Kelly

Full Kelly is too aggressive. Use quarter-Kelly:

```
edge = our_probability - market_implied_probability
kelly_fraction = edge / (1 - market_implied_probability)
position_size = 0.25 * kelly_fraction * bankroll
```

### Hard Limits (Circuit Breaker, adapted from Market Agent)

- **Max concurrent positions:** 10 (prediction markets are lower correlation than crypto)
- **Max single position:** 5% of bankroll
- **Max daily loss:** 3% of bankroll → halt for 24h
- **Max drawdown:** 10% from peak → halt until manual review
- **Consecutive losses:** 5 → reduce position sizes by 50%
- **Min edge threshold:** Only trade when |edge_vs_market| > 5¢ (5 percentage points)
- **Min confidence:** Only trade when Claude confidence > 0.6

### Human Approval Gate

Phase 1: ALL trades require human approval (same as Market Agent).
Phase 2: Auto-approve trades below $10 with edge > 10¢ and confidence > 0.8.
Phase 3: Full auto with circuit breaker only.

---

## 7. Capital Plan

### Starting Capital: $2,000-5,000

| Amount | Source | Purpose |
|--------|--------|---------|
| $20 | Invite code bonus | Free capital, test trades |
| $500 | Initial deposit | Paper-equivalent live testing (micro positions) |
| $2,000-5,000 | Scale-up after edge validation | Full deployment |

### Unit Economics

At $5,000 deployed with quarter-Kelly on 5¢+ edges:
- Average position: $50-250
- Average edge: 5-10¢ (5-10%)
- Win rate (calibrated): 55-60%
- Expected trades/day: 5-15
- Expected daily P&L: $10-75 (before API costs)
- API costs: $5-15/day
- Net daily: $0-60
- Monthly range: $0-1,800

This is conservative. The range widens dramatically with capital and demonstrated edge.

---

## 8. Week-by-Week Build Plan

### Week 1: Foundation (Days 1-7)

**Goal:** Working Polymarket client, account setup, first manual analysis

- [ ] Create Polymarket account (invite code, fund with $20+)
- [ ] Initialize `poly-agent/` project alongside market-agent
- [ ] Install `@polymarket/clob-client`, set up wallet
- [ ] Build market discovery module (list active sports markets)
- [ ] Build odds monitor (poll prices every 30s for target markets)
- [ ] Port Claude analysis pipeline (adapt qualitative prompts for prediction markets)
- [ ] First manual test: have Claude analyze a live market, compare to actual odds

**Deliverable:** Can fetch markets, read odds, and get Claude probability estimates.

### Week 2: Analysis Engine (Days 8-14)

**Goal:** Automated news → probability pipeline

- [ ] Build sports news ingest (ESPN headlines, injury reports)
- [ ] Build fair value estimation prompt + pipeline
- [ ] Build overreaction detection prompt + pipeline
- [ ] Postgres schema for predictions (markets, estimates, outcomes, P&L)
- [ ] Calibration logging: record every estimate for later accuracy measurement
- [ ] Dashboard v1: show active markets, our estimates vs market odds, identified edges

**Deliverable:** System automatically identifies markets where our estimate diverges from market price.

### Week 3: Execution & Risk (Days 15-21)

**Goal:** Can place orders with full risk management

- [ ] Build order manager (place limit orders via CLOB API)
- [ ] Port circuit breaker from Market Agent (adapt thresholds)
- [ ] Port human approval gate (proposals for each identified trade)
- [ ] Build position tracker (monitor fills, track P&L per market)
- [ ] Kelly sizing implementation
- [ ] Integration test: full pipeline from news → analysis → proposal → approval → order

**Deliverable:** End-to-end system ready for live micro-trading.

### Week 4: Live Testing (Days 22-28)

**Goal:** Live trades with real (small) money, validate edge

- [ ] Deploy to Render (same infra as Market Agent)
- [ ] Start with $50-100 in micro positions ($5-10 per trade)
- [ ] Track every prediction vs outcome for calibration
- [ ] Identify systematic biases (overconfident? underconfident? category-specific?)
- [ ] Refine prompts based on first week of live results
- [ ] Build P&L dashboard with position-level attribution

**Deliverable:** 50+ live predictions with outcome tracking. Initial calibration data.

### Weeks 5-8: Optimize & Scale

- Analyze calibration data, tune prompts
- Increase position sizes if edge validates
- Add more sports categories (MLB, NBA playoffs, soccer)
- Build secondary strategies (overreaction fading as separate module)
- Automate approval for high-confidence trades
- Scale capital to $2K-5K

### Weeks 9-12: Expand

- Add crypto/politics markets as they become available to US users
- Cross-market arbitrage module (Polymarket ↔ Kalshi)
- Multi-model ensemble (Claude + historical base rates)
- Revenue target: demonstrate consistent $500+/month

---

## 9. Key Risks

1. **Calibration failure.** If Claude's probability estimates aren't calibrated, every trade has negative expected value. Mitigation: extensive paper tracking before scaling.

2. **US market expansion delay.** If sports-only persists through 2026, the addressable market is smaller. Mitigation: sports alone has massive volume — this is acceptable.

3. **API changes or rate limits.** Polymarket could restrict bot access. Mitigation: maker-only strategy is market-positive (provides liquidity), less likely to be restricted.

4. **Competition intensifies.** More AI agents enter → edges compress. Mitigation: move fast, accumulate calibration data advantage.

5. **Regulatory risk.** State-level challenges could temporarily restrict access. Mitigation: federal CFTC approval provides strong foundation.

6. **Capital risk.** All trading capital is at risk. Mitigation: strict circuit breakers, quarter-Kelly sizing, never deploy more than you can afford to lose.

---

## 10. Success Criteria

| Milestone | Target | Timeframe |
|-----------|--------|-----------|
| First live prediction | Placed and tracked | Week 1 |
| 50 tracked predictions | Calibration baseline | Week 4 |
| Positive P&L week | Any amount | Week 4-6 |
| Calibration within 5% | Brier score assessment | Week 8 |
| $500/month run rate | Sustained over 2 weeks | Week 8-12 |
| $2,000/month run rate | Scale validation | Month 4-6 |

---

## 11. Why Now

The window is open. 30% of Polymarket wallets are already bots, but most are simple arbitrage or copy-trading. The information-processing edge — using Claude to analyze news faster and more accurately than the market — is the next frontier. We have the infrastructure (Claude API, Node.js, Postgres, Render), the domain knowledge (3 months of Market Agent development), and the qualitative pipeline already built.

The regulated US market launched 3 months ago. Competition is growing but not yet saturated. Every week we wait, the edge compresses.

Start building Week 1 today.
