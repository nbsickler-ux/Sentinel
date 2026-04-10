# Kalshi Trading Bot — Combined Strategy

## The Thesis

Two complementary edges, one bot:

**Layer 1 — Favorite-Longshot Bias Scanner (all markets):** Kalshi contracts under 10¢ systematically lose over 60% of money invested. Contracts over 80¢ systematically outperform. This is a documented, persistent structural mispricing across the entire platform — sports, weather, politics, crypto, economics. We scan every open market on Kalshi, identify contracts where the bias is strongest, and trade against the crowd.

**Layer 2 — Weather Intelligence (temperature markets):** On top of the bias scanner, we add ensemble weather model data (GEFS + ECMWF) for Kalshi's temperature markets. This gives us a precise probability distribution to compare against market prices — not just "this looks overpriced" but "this is priced at 24¢ and our model says it should be 38¢."

Layer 1 gives us breadth (thousands of contracts). Layer 2 gives us depth (precise edge sizing on weather). Together, they maximize the opportunity set.

---

## Layer 1: Favorite-Longshot Bias

### The Edge

Academic research on Kalshi documents that:
- Contracts priced <10¢ win only ~4% of the time (should be ~10%) — overpriced by ~60%
- Contracts priced >80¢ win more often than their price implies — underpriced
- Average pre-fee return across ALL Kalshi traders is -20%
- Makers (resting orders) lose 10% on average; Takers lose 32%
- The bias persists even with institutional market makers and bots present

### How We Exploit It

**Strategy: Sell overpriced longshots + Buy underpriced favorites**

For every open market on Kalshi:

```
If contract price < 10¢:
  → Candidate for SELLING YES (or BUYING NO)
  → These contracts expire worthless far more often than their price implies

If contract price > 85¢:
  → Candidate for BUYING YES
  → These contracts settle at $1 more often than their price implies
```

**Edge calculation:**
```
For cheap contracts (selling YES):
  implied_prob = market_price (e.g., 0.08 = 8%)
  historical_win_rate = lookup from bias curve (e.g., ~4% for 8¢ contracts)
  edge = implied_prob - historical_win_rate - fees

For expensive contracts (buying YES):
  implied_prob = market_price (e.g., 0.90 = 90%)
  historical_win_rate = lookup from bias curve (e.g., ~93% for 90¢ contracts)
  edge = historical_win_rate - implied_prob - fees
```

### Risk on Selling Longshots

Selling a 5¢ contract means you collect 5¢ but risk losing 95¢ if the event happens. This is asymmetric risk. To manage it:

- **Never concentrate.** Spread across many contracts so no single event can blow you up.
- **Position size by max loss, not edge.** If max loss per contract is 95¢, size to keep max loss per trade under 3% of capital ($15 on $500).
- **Diversify across categories.** Don't sell 10 cheap sports contracts on the same day — one upset wipes them all. Mix weather, politics, economics, sports.
- **Volume filter.** Only trade contracts with meaningful volume — thin markets have wider spreads and worse execution.

### Scanning Logic

Every 5 minutes:
1. Fetch all open Kalshi markets (paginate through full catalog)
2. For each contract, record: price, volume, category, close time, spread
3. Flag contracts in the bias sweet spots (<10¢ or >85¢)
4. Apply filters: minimum volume, minimum time to settlement, category diversification
5. Rank by edge magnitude
6. Queue top candidates for execution

### What We Need to Build (Bias Curve)

Before trading live, we need to calibrate the bias curve — the relationship between market price and actual win rate. This requires:
- Historical Kalshi settlement data (which contracts settled YES vs NO at each price point)
- Kalshi may provide this through their API (settled markets) or we build it from our own tracking

If historical data isn't available via API, we paper-trade and build the curve from our own observations over 2 weeks.

---

## Layer 2: Weather Intelligence

### Market Structure

**Cities:** NYC (Central Park), Chicago, Miami, Los Angeles, Denver
**Series tickers:** KXHIGHNY, KXHIGHCHI, KXHIGHMIA, KXHIGHLAX, KXHIGHDEN

**Contract structure:** 6 brackets per city per day:
- 4 middle brackets: 2°F intervals (e.g., 79-80°F, 81-82°F, 83-84°F, 85-86°F)
- 2 edge brackets: "Below 79°F" and "87°F+"
- Each bracket pays $1 if actual high falls in that range, $0 otherwise

**Timing:**
- Markets launch: 10:00 AM ET the day before
- Settlement: Next morning using NWS Daily Climate Report
- Trading window: ~22 hours

**Daily opportunity:** 5 cities × 6 brackets = 30 contracts per day

### The Weather Edge

Ensemble weather models give us a probability distribution that most retail traders don't use:

```
model_probability = (ensemble members in bracket) / (total members)
market_price = current Kalshi YES price for that bracket
edge = model_probability - market_price - fees
```

This stacks on top of the longshot bias. A weather contract priced at 8¢ might be overpriced BOTH because of the longshot bias AND because the ensemble model says the true probability is only 3%.

### Data Source: Open-Meteo Ensemble API (free, no key)

```
GET https://ensemble-api.open-meteo.com/v1/ensemble
  ?latitude=40.7828&longitude=-73.9653    # Central Park
  &hourly=temperature_2m_max
  &models=gfs_seamless,ecmwf_ifs025
  &forecast_days=2
```

Returns all ensemble members. Built-in probability syntax:
```
p~temperature_2m~moreeq~27  →  P(temp ≥ 27°C) directly
```

### Weather-Specific Edge Calculation

For each city/bracket:
1. Get ensemble probability from Open-Meteo
2. Get current Kalshi market price
3. Compute edge = model_prob - market_price - fees
4. If edge > threshold AND passes circuit breaker → trade
5. Hold to settlement (default) or exit early on adverse forecast update

---

## Position Holding Strategy

### Default: Hold to Settlement

The math strongly favors holding to settlement:
- Round-trip fees are ~3.5% at mid-range prices
- Exiting and re-entering costs 7% in fees alone
- Settlement gives you the full $1 payoff minus only entry fee
- Early exit at +10¢ profit often nets less than holding for the binary $1/$0 outcome

### Exception: Exit Early When

1. **New forecast data materially contradicts position** (weather markets only)
2. **Deep in profit near settlement** and want to lock gains vs gamma risk
3. **Circuit breaker approaching** daily loss limit — reduce exposure

### Never: Exit and Re-enter

Fee structure makes round-trip re-entry unprofitable unless the new edge is >5%.

---

## Execution Logic

### Cycle 1: Market Scan (every 5 min)
1. Fetch all open Kalshi markets
2. Classify: weather (temperature), sports, politics, economics, crypto, other
3. For each contract: record price, volume, spread, time to settlement

### Cycle 2: Edge Detection (every 60 sec)
1. **Bias scanner:** Flag contracts <10¢ or >85¢ as bias candidates
2. **Weather model:** For temperature contracts, compute ensemble probability
3. **Combined edge:** For weather contracts, use MAX(bias_edge, model_edge)
4. **Rank all edges** across categories by magnitude
5. Apply filters: min volume, min edge threshold, category diversification

### Cycle 3: Execution (on edge detection)
1. Check circuit breaker
2. Check position limits (max contracts per trade, max capital deployed)
3. Place limit order at best available price
4. Log: edge type (bias/weather/combined), magnitude, price, model data

### Cycle 4: Settlement Tracking (daily, morning)
1. Pull NWS climate reports for weather markets
2. Check settlement status for all tracked contracts
3. Record outcome vs predicted probability
4. Update calibration metrics and bias curve

---

## Risk Management

### Position Sizing (<$500 capital)

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Max per trade | $10 (10-20 contracts at 50-100¢) | Limits single-event risk |
| Max capital deployed | 30% ($150) | Reserves for drawdowns |
| Max positions | 8-10 simultaneous | Diversification |
| Max per category | 3 positions | No single-category concentration |
| Max longshot sell exposure | $50 total | Caps asymmetric loss risk |

### Circuit Breaker
- Daily loss limit: $25 (5% of capital)
- 3 consecutive losing days → pause for manual review
- Model accuracy <40% over 7 days → recalibrate before resuming
- Single-event loss >$20 → reduce position sizes by 50%

### Category Diversification
- Never more than 3 open positions in same category
- Weather positions should not all be in same city
- Longshot sells should span at least 3 different event types

---

## Calibration & Validation Plan

### Phase 1: Validate Mechanics + Math (Day 1-2)

Deploy in analysis mode. Bot runs live, fetches data, computes edges, logs everything. No trades.

**Verify:**
- Pipeline runs end-to-end without errors (markets fetched, weather data pulled, edges computed)
- Edge math is correct after fees — are detected edges real or eaten by fee drag?
- How many edges >8¢ per day? If zero, rethink. If 5+, proceed.
- Weather model probabilities look sane vs market prices

### Phase 2: Small Live (Day 3+)
- 1-2 contracts per trade ($1-$2 per position)
- Review first day's results — did settlements confirm edge?
- If yes, scale to 3-5 contracts per trade within the week

### Phase 3: Full Capital (Week 2+)
- 5-10 contracts per trade
- Full $500 deployed
- Daily P&L review
- Adjust thresholds based on live data

---

## Technical Architecture

### Repurposing poly-agent

**What stays (unchanged):**
- kalshi.js — RSA authentication, order placement, position management
- circuit-breaker.js — risk controls
- positions.js — position tracking
- db/schema.js — database
- logger.js — logging
- server.js — Express monitoring API
- Render deployment + environment variables

**What gets replaced:**
- bookmaker.js → **weather.js** (Open-Meteo ensemble data)
- edge.js → **edge.js** (rewritten: bias scanner + weather model comparison)
- agent.js → rewritten for new scan/detect/execute cycle
- config.js → new configuration for bias thresholds, weather cities, etc.

**What gets added:**
- **bias-scanner.js** — scan all Kalshi markets for longshot bias opportunities
- **weather.js** — Open-Meteo ensemble data fetcher + probability calculator
- **calibration.js** — track model accuracy, build bias curve, compute Brier scores
- **/api/calibration** endpoint — dashboard for monitoring model performance
- **/api/edges** endpoint — live view of detected edges

### Development Plan

**Session 1:** Core infrastructure
- Strip out sports/bookmaker code
- Build bias scanner (fetch all markets, classify, flag bias candidates)
- Build weather data pipeline (Open-Meteo API integration)
- New edge detection combining bias + weather model

**Session 2:** Execution + risk
- Paper trading mode (log trades without executing)
- Circuit breaker updates for new strategy
- Position sizing logic
- Settlement tracking

**Session 3:** Calibration + monitoring
- Bias curve builder from historical/paper data
- Weather model calibration scoring
- Dashboard endpoints
- Daily reporting

---

## Success Metrics

| Metric | Target | Timeframe |
|--------|--------|-----------|
| Edges detected per day | >5 tradeable | Week 1-2 |
| Paper trade win rate | >55% | Week 1-2 |
| Bias curve accuracy | Matches academic findings (±5%) | Week 1-2 |
| Weather Brier score | <0.15 | Week 1-2 |
| Live win rate | >55% | Month 1 |
| Daily P&L | +$5-$15/day | Month 1 |
| Monthly return | 15-30% on deployed capital | Month 2+ |
| Max drawdown | <15% of total capital | Ongoing |

---

## What Could Go Wrong

1. **Bias already arbitraged away.** Paper trading will reveal this within days.
2. **Weather markets too efficient.** Ensemble data is free — maybe everyone uses it. Paper trading will show if our model beats the market.
3. **Thin liquidity.** Can't get filled at desired prices. Monitor orderbook depth and adjust.
4. **Longshot tail risk.** One unlikely event wipes out weeks of small gains. Position sizing and diversification are the defense.
5. **Fee drag on small edges.** We need edges >8¢ to be profitable. If most edges are 3-5¢, the strategy doesn't work.
6. **API changes.** Kalshi or Open-Meteo change their API. Low risk but worth monitoring.
