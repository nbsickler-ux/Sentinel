# Weather Bot Strategy — Kalshi Temperature Markets

## The Thesis

Kalshi's daily temperature markets are priced by retail traders using intuition and basic weather app forecasts. We use ensemble weather models (GEFS 21-member + ECMWF) to compute precise probability distributions for each temperature bracket. When the model's probability diverges from the market price by more than our fee + edge threshold, we trade.

This is not a prediction game — it's a calibration game. We don't need to know if it will be 82°F or 84°F. We need to know the probability distribution better than the market does.

---

## Market Structure

**Cities:** NYC (Central Park), Chicago, Miami, Los Angeles, Denver
**Series tickers:** KXHIGHNY, KXHIGHCHI, KXHIGHMIA, KXHIGHLAX, KXHIGHDEN

**Contract structure:** 6 brackets per city per day:
- 4 middle brackets: 2°F intervals (e.g., 79-80°F, 81-82°F, 83-84°F, 85-86°F)
- 2 edge brackets: "Below 79°F" and "87°F+"
- Each bracket is a separate contract: pays $1 if actual high falls in that range, $0 otherwise

**Timing:**
- Markets launch: 10:00 AM ET the day before
- Trading window: ~22 hours
- Settlement: Next morning using NWS Daily Climate Report from the designated weather station
- Settlement source: Official NWS data — deterministic, no ambiguity

**Daily opportunity:** 5 cities × 6 brackets = 30 contracts per day

---

## The Edge

### Why this edge exists

1. **Retail traders use single-point forecasts.** Weather apps say "High: 83°F" — they don't say "there's a 35% chance it's 81-82, 40% chance 83-84, 15% chance 85-86." Retail traders anchor to the point forecast and overprice the bracket that contains it.

2. **Ensemble models give us the actual distribution.** GEFS runs 21 simulations with slightly different initial conditions. If 8 members land in 81-82°F, 9 in 83-84°F, 3 in 85-86°F, and 1 in 87°F+, we have a well-calibrated probability distribution.

3. **The edge is structural, not informational.** We're not predicting weather better — we're pricing uncertainty better. The average trader thinks in point estimates; we think in distributions.

### Edge calculation

For each bracket:
```
model_probability = (ensemble members in bracket) / (total members)
market_price = current Kalshi YES price for that bracket
edge = model_probability - market_price - round_trip_fees
```

Kalshi fee formula: `0.07 × P × (1-P)` per contract
Round-trip fee: entry fee + exit fee (if we sell before settlement) or just entry fee (if we hold to settlement)

**Minimum edge to trade:** TBD after calibration, but likely 8-12¢ (8-12 percentage points of mispricing)

### Example

NYC tomorrow. Our ensemble model says:
| Bracket | Model Prob | Kalshi Price | Edge |
|---------|-----------|-------------|------|
| Below 79°F | 5% | $0.04 | +1¢ (skip — below threshold) |
| 79-80°F | 14% | $0.08 | +6¢ (borderline) |
| 81-82°F | 38% | $0.24 | +14¢ — **BUY** |
| 83-84°F | 29% | $0.42 | -13¢ — **SELL (or buy NO)** |
| 85-86°F | 10% | $0.18 | -8¢ (borderline sell) |
| 87°F+ | 4% | $0.04 | 0¢ (skip) |

In this example, the market is overpricing the 83-84 bracket (retail anchoring to "83°F" forecast) and underpricing 81-82. We buy 81-82 YES and sell 83-84 YES (or buy 83-84 NO).

---

## Data Pipeline

### Primary: Open-Meteo Ensemble API (free, no key required)

```
GET https://ensemble-api.open-meteo.com/v1/ensemble
  ?latitude=40.7828&longitude=-73.9653    # Central Park
  &hourly=temperature_2m_max
  &models=gfs_seamless,ecmwf_ifs025
  &forecast_days=2
```

Returns all ensemble members. We compute our own probability distribution.

**Built-in probability endpoint:**
```
p~temperature_2m~moreeq~27  →  P(temp ≥ 27°C) directly
```

### Secondary: GEFS via AWS (21-member ensemble, free)

For more granular control and historical backtesting:
- AWS Registry: registry.opendata.aws/noaa-gefs/
- 4 runs per day (00, 06, 12, 18 UTC)
- Python library: `herbie-data`

### Settlement verification: NWS Climate Reports

Same source Kalshi uses to settle contracts:
- https://www.weather.gov/wrh/climate
- We pull this to verify our model accuracy over time

---

## Execution Logic

### Market discovery (every 30 min)
1. Fetch open markets from Kalshi for each series ticker (KXHIGHNY, etc.)
2. Parse bracket ranges from yes_sub_title
3. Store in state with current prices

### Forecast update (every 6 hours, aligned to model runs)
1. Pull latest ensemble data from Open-Meteo for all 5 cities
2. Compute probability distribution across brackets
3. Store model probabilities

### Edge scan (every 60 seconds)
1. For each city/bracket, compute: model_prob - market_price - fees
2. If edge > threshold → queue for execution
3. Log all edges (even sub-threshold) for calibration tracking

### Order execution
1. Check circuit breaker (daily loss limit, position concentration)
2. Place limit order at current best price (not market order)
3. Size: fixed contract count based on capital and edge magnitude
4. Log trade with model probability, market price, edge at time of entry

### Position management
1. **Hold to settlement** (primary strategy) — no exit needed, contract resolves to $1 or $0
2. **Early exit** if edge reverses significantly (market moves toward our model price = less profit but still profitable)
3. **No stop losses on individual trades** — we're playing probabilities across many trades, not trying to be right on each one

### Settlement tracking
1. Pull NWS climate report next morning
2. Record actual outcome vs model probability vs market price
3. Update calibration metrics
4. Track P&L per city, per bracket position, per edge magnitude

---

## Risk Management

### Position sizing
With <$500 starting capital:
- Max 5-10 contracts per trade ($5-$10 risk per position)
- Max 3-4 simultaneous positions
- Never more than 30% of capital deployed at once
- Scale up only after 2+ weeks of positive calibration data

### Circuit breaker
- Daily loss limit: $25 (5% of $500)
- If model accuracy drops below 40% over trailing 7 days → pause and recalibrate
- If 3 consecutive days of net loss → pause for manual review

### Diversification
- Trade across multiple cities (don't concentrate on one)
- Trade multiple brackets per city when edges exist
- The law of large numbers is our friend — 30 contracts/day × 7 days = 210 independent bets per week

---

## Calibration & Validation Plan

### Before deploying real capital (Week 1-2):

**Paper trading mode:**
1. Bot runs, identifies edges, logs what it WOULD have traded
2. We track: Would these trades have been profitable?
3. Compare model probabilities to actual outcomes
4. Compute Brier score (calibration metric) for our model vs the market

**Key questions to answer:**
- How often does our model disagree with the market by >8¢?
- When it disagrees, who is right more often — us or the market?
- What's the average edge magnitude on winning vs losing trades?
- Are there systematic biases by city, time of day, or weather regime?

### After validation (Week 3+):
- Start with 1-2 contracts per trade
- Scale to 5-10 as confidence grows
- Daily review of P&L and model accuracy

---

## What Could Go Wrong

1. **Market is already efficient.** If Kalshi traders are already using ensemble data, our edge is zero. Paper trading will reveal this quickly.

2. **Thin liquidity at our desired prices.** We might see an edge but can't get filled. Need to monitor orderbook depth.

3. **Model miscalibration in extreme weather.** Ensemble models are less reliable during unusual weather patterns (heat waves, cold snaps, storms). These are also when the market is most uncertain — could be opportunity or trap.

4. **Fee drag.** Round-trip fees of 2-3.5¢ per contract eat into small edges. We need edges >8¢ to be meaningfully profitable after fees.

5. **Settlement station quirks.** The NWS station might report differently than our model's grid point. Need to calibrate for station-specific biases.

---

## Technical Architecture (Repurposing poly-agent)

### What stays:
- Kalshi RSA authentication (kalshi.js)
- Order placement and management
- Position tracking (positions.js)
- Circuit breaker (circuit-breaker.js)
- Database schema and logging
- Express server + monitoring endpoints
- Render deployment

### What gets replaced:
- **bookmaker.js** → **weather.js** (Open-Meteo ensemble data fetcher)
- **edge.js** → rewritten for bracket probability comparison
- **agent.js** → simplified cycle: discover weather markets → update forecast → scan edges → execute
- **config.js** → weather-specific config (cities, thresholds, model settings)

### What gets added:
- Bracket parser (extract temperature ranges from Kalshi market data)
- Ensemble-to-probability converter
- Settlement tracker (pull NWS climate reports)
- Calibration dashboard endpoint (/api/calibration)

### Estimated development time: 2-3 sessions
- Session 1: Weather data pipeline + bracket parsing + edge calculation
- Session 2: Execution logic + position management + risk controls
- Session 3: Calibration tracking + paper trading mode + monitoring

---

## Success Metrics

| Metric | Target | Timeframe |
|--------|--------|-----------|
| Model Brier score | < 0.15 (better than market) | Week 1-2 |
| Edge frequency | >3 tradeable edges per day | Week 1-2 |
| Win rate | >55% of trades profitable | Week 3+ |
| Daily P&L | +$5-$15/day on $500 capital | Month 1 |
| Monthly return | 15-30% | Month 2+ |
| Max drawdown | <15% of capital | Ongoing |
