// ============================================================
// WEATHER BOT: MAIN ORCHESTRATOR
//
// Architecture:
//   Two parallel data streams:
//     1. Kalshi temperature markets (every 60s) — market prices
//     2. Open-Meteo ensemble forecasts (every 5 min) — model probabilities
//   Edge = model_probability − market_price − fees
//   No LLM. Pure math. Ensemble statistics vs market prices.
//
// Three operating modes:
//   "analysis"    — Detect edges + log, execute nothing
//   "guarded"     — Auto-execute within tight guardrails
//   "autonomous"  — Full auto, circuit breaker is the only gate
//
// Cycle:
//   1. Discover Kalshi temperature markets (KXHIGH* series)
//   2. Fetch ensemble forecasts for all 5 cities
//   3. Parse brackets, compute probabilities, find edges
//   4. Execute or log based on mode
//   5. Hold to settlement (default)
// ============================================================

import config from "./config.js";
import logger from "./logger.js";
import * as kalshi from "./execution/kalshi.js";
import {
  CITIES,
  fetchAllForecasts,
  parseBracketFromTitle,
  getTomorrowDateET,
  getTodayDateET,
} from "./execution/weather.js";
import { findWeatherEdges, summarizeEdges } from "./analysis/edge.js";
import { checkCircuitBreaker } from "./risk/circuit-breaker.js";
import { createProposal, approveProposal } from "./execution/manager.js";
import { pool } from "./db/schema.js";

// ── STATE ──

const state = {
  // Kalshi temperature markets, parsed with bracket info
  weatherMarkets: [],

  // Latest ensemble forecasts: cityCode → { members, modelInfo }
  forecasts: {},

  // Detected edges this cycle
  detectedEdges: [],

  // Trade log for daily review
  tradeLog: [],

  // Timestamps
  lastMarketScan: 0,
  lastForecastFetch: 0,
  lastEdgeScan: 0,

  cycleCount: 0,
  running: false,

  stats: {
    edgesDetected: 0,
    edgesActedOn: 0,
    autoExecuted: 0,
    marketsFound: 0,
    forecastFetches: 0,
    kalshiPolls: 0,
  },
};

// ── MARKET DISCOVERY ──

/**
 * Fetch Kalshi temperature markets for all 5 cities.
 * Uses series tickers: KXHIGHNY, KXHIGHCHI, KXHIGHMIA, KXHIGHLAX, KXHIGHDEN
 */
async function discoverWeatherMarkets() {
  const now = Date.now();
  const scanIntervalMs = config.weather?.marketScanMs || 300_000; // 5 min
  if (now - state.lastMarketScan < scanIntervalMs) return;
  state.lastMarketScan = now;

  const allMarkets = [];

  for (const [cityCode, city] of Object.entries(CITIES)) {
    try {
      // Fetch markets for this city's series
      const markets = await kalshi.getMarkets({
        seriesTicker: city.seriesTicker,
        status: "open",
        limit: 50,
      });

      for (const m of markets) {
        // Parse the bracket from the market title
        const bracketTitle = m.yes_sub_title || m.no_sub_title || "";
        const bracket = parseBracketFromTitle(bracketTitle);

        if (!bracket) {
          logger.debug({
            module: "agent",
            ticker: m.ticker,
            title: bracketTitle,
          }, "Could not parse bracket — skipping");
          continue;
        }

        // Parse YES price
        let yesPrice = null;
        if (m.yes_ask != null) {
          yesPrice = m.yes_ask > 1 ? m.yes_ask / 100 : m.yes_ask;
        } else if (m.last_price != null) {
          yesPrice = m.last_price > 1 ? m.last_price / 100 : m.last_price;
        }

        allMarkets.push({
          ticker: m.ticker,
          cityCode,
          cityName: city.name,
          seriesTicker: city.seriesTicker,
          bracket,
          bracketLabel: bracketTitle,
          yesPrice,
          noPrice: yesPrice != null ? 1 - yesPrice : null,
          volume: m.volume || 0,
          openInterest: m.open_interest || 0,
          closeTime: m.close_time || m.expiration_time,
          rawData: m,
        });
      }

      logger.info({
        module: "agent",
        city: city.name,
        series: city.seriesTicker,
        found: markets.length,
        parsed: allMarkets.filter(m => m.cityCode === cityCode).length,
      }, "Weather markets discovered");
    } catch (err) {
      logger.error({
        module: "agent",
        city: city.name,
        err: err.message,
      }, "Failed to fetch weather markets");
    }
  }

  state.weatherMarkets = allMarkets;
  state.stats.marketsFound = allMarkets.length;

  logger.info({
    module: "agent",
    totalMarkets: allMarkets.length,
    cities: [...new Set(allMarkets.map(m => m.cityCode))].length,
    brackets: allMarkets.map(m => `${m.cityCode}:${m.bracketLabel}`).slice(0, 5),
  }, "Weather market discovery complete");

  return allMarkets;
}

// ── FORECAST FETCHING ──

/**
 * Fetch ensemble forecasts for tomorrow (the day temperature markets settle on).
 */
async function fetchForecasts() {
  const now = Date.now();
  const fetchIntervalMs = config.weather?.forecastPollMs || 300_000; // 5 min
  if (now - state.lastForecastFetch < fetchIntervalMs) return;
  state.lastForecastFetch = now;
  state.stats.forecastFetches++;

  // Temperature markets launched today settle tomorrow
  // Fetch both today and tomorrow to cover markets settling either day
  const tomorrow = getTomorrowDateET();
  const today = getTodayDateET();

  // Primary: tomorrow's forecast (most markets)
  state.forecasts = await fetchAllForecasts(tomorrow);

  // Also check if any markets settle today (launched yesterday)
  const todayForecasts = await fetchAllForecasts(today);

  // Merge: keep tomorrow as primary, add today data under separate key
  state.forecastsToday = todayForecasts;

  logger.info({
    module: "agent",
    tomorrowDate: tomorrow,
    todayDate: today,
    tomorrowMembers: Object.values(state.forecasts).reduce((s, f) => s + f.members.length, 0),
    todayMembers: Object.values(todayForecasts).reduce((s, f) => s + f.members.length, 0),
  }, "Forecasts updated");
}

// ── EDGE DETECTION + EXECUTION ──

/**
 * Main edge scan: compare model probabilities to market prices.
 */
async function edgeScanCycle() {
  const now = Date.now();
  const scanIntervalMs = config.weather?.edgeScanMs || 60_000; // 60s
  if (now - state.lastEdgeScan < scanIntervalMs) return;
  state.lastEdgeScan = now;
  state.stats.kalshiPolls++;

  if (state.weatherMarkets.length === 0) {
    logger.debug({ module: "agent" }, "No weather markets — skipping edge scan");
    return;
  }

  if (Object.keys(state.forecasts).length === 0) {
    logger.debug({ module: "agent" }, "No forecasts — skipping edge scan");
    return;
  }

  // Refresh prices on all weather markets
  for (const market of state.weatherMarkets) {
    try {
      const freshMarket = await kalshi.getMarket(market.ticker);
      if (freshMarket) {
        if (freshMarket.yes_ask != null) {
          market.yesPrice = freshMarket.yes_ask > 1 ? freshMarket.yes_ask / 100 : freshMarket.yes_ask;
        } else if (freshMarket.last_price != null) {
          market.yesPrice = freshMarket.last_price > 1 ? freshMarket.last_price / 100 : freshMarket.last_price;
        }
        market.volume = freshMarket.volume || market.volume;
      }
    } catch (err) {
      // Keep stale price, log and continue
      logger.debug({ module: "agent", ticker: market.ticker, err: err.message }, "Price refresh failed");
    }
  }

  // Find edges using tomorrow's forecasts (primary)
  const edges = findWeatherEdges(
    state.weatherMarkets,
    state.forecasts,
    {
      minEdgeCents: config.weather?.minEdgeCents || 5,
      tradeEdgeCents: config.weather?.tradeEdgeCents || 7,
      minVolume: config.weather?.minVolume || 0,
      minMembers: config.weather?.minMembers || 10,
    }
  );

  state.detectedEdges = edges;

  if (edges.length > 0) {
    state.stats.edgesDetected += edges.length;
    const summary = summarizeEdges(edges);

    logger.info({
      module: "agent",
      ...summary,
    }, "Edge scan complete");

    // Process trade-eligible edges
    const tradeEligible = edges.filter(e => e.tradeEligible);
    for (const edge of tradeEligible) {
      await actOnEdge(edge);
    }

    // Log all edges for calibration
    for (const edge of edges) {
      state.tradeLog.push({
        timestamp: Date.now(),
        type: edge.tradeEligible ? "edge_trade_eligible" : "edge_logged",
        ...edge,
        executed: false,
      });
    }
  } else {
    logger.info({ module: "agent", markets: state.weatherMarkets.length }, "No edges found this cycle");
  }
}

// ── EDGE EXECUTION ──

async function actOnEdge(edge) {
  if (!edge.tradeEligible) return;

  const breaker = await checkCircuitBreaker();
  if (!breaker.allowed) {
    logger.warn({ module: "agent", reason: breaker.reason, market: edge.ticker }, "Circuit breaker blocked");
    return;
  }

  const bankroll = breaker.details?.current_bankroll || 500;

  // Build proposal
  const proposalData = {
    direction: edge.side === "buy_yes" ? "buy_yes" : "buy_no",
    edge_vs_market: edge.netEdgeCents,
    fair_value: edge.modelProb,
    confidence: edge.confidence,
    market_price: edge.marketPrice,
    reasoning: `Weather edge: model=${(edge.modelProb * 100).toFixed(1)}% vs market=${(edge.marketPrice * 100).toFixed(1)}% (${edge.ensembleMembers} members, ${edge.netEdgeCents}¢ net after ${edge.feeCents}¢ fee) [${edge.cityName} ${edge.bracketLabel}]`,
    condition_id: edge.ticker,
  };

  const proposal = await createProposal(proposalData, bankroll, breaker.details?.size_multiplier || 1);
  if (!proposal) return;

  state.stats.edgesActedOn++;

  if (config.mode === "analysis") {
    logger.info({
      module: "agent",
      mode: "analysis",
      ticker: edge.ticker,
      city: edge.cityName,
      bracket: edge.bracketLabel,
      side: edge.side,
      modelProb: `${(edge.modelProb * 100).toFixed(1)}%`,
      marketPrice: `${(edge.marketPrice * 100).toFixed(1)}%`,
      netEdge: `${edge.netEdgeCents}¢`,
      members: edge.ensembleMembers,
    }, "Edge logged (analysis mode — no execution)");

  } else if (config.mode === "guarded") {
    const { maxSizeUsd, minEdgeCents, minConfidence } = config.autoExec;
    const withinGuardrails =
      proposal.size_usd <= maxSizeUsd &&
      edge.netEdgeCents >= minEdgeCents &&
      edge.confidence >= minConfidence;

    if (withinGuardrails) {
      const result = await approveProposal(proposal.id);
      if (result?.success) {
        state.stats.autoExecuted++;
        state.tradeLog.push({ timestamp: Date.now(), type: "executed", ...edge, executed: true });
        logger.info({
          module: "agent",
          mode: "guarded",
          ticker: edge.ticker,
          side: edge.side,
          edge: `${edge.netEdgeCents}¢`,
          size: `$${proposal.size_usd}`,
        }, "Auto-executed (within guardrails)");
      }
    } else {
      logger.info({
        module: "agent",
        mode: "guarded",
        ticker: edge.ticker,
        reason: proposal.size_usd > maxSizeUsd ? "size_exceeds_limit"
          : edge.netEdgeCents < minEdgeCents ? "edge_below_threshold"
          : "confidence_below_threshold",
      }, "Edge held (outside guardrails)");
    }

  } else if (config.mode === "autonomous") {
    const result = await approveProposal(proposal.id);
    if (result?.success) {
      state.stats.autoExecuted++;
      state.tradeLog.push({ timestamp: Date.now(), type: "executed", ...edge, executed: true });
      logger.info({
        module: "agent",
        mode: "autonomous",
        ticker: edge.ticker,
        edge: `${edge.netEdgeCents}¢`,
        size: `$${proposal.size_usd}`,
      }, "Auto-executed (autonomous)");
    }
  }

  // Record to DB
  if (pool) {
    pool.query(
      `INSERT INTO poly_edges (market_id, ticker, side, kalshi_price, fair_value, edge_cents, sharp_book, bookmaker_count, executed, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [edge.ticker, edge.ticker, edge.side, edge.marketPrice, edge.modelProb, edge.netEdgeCents, "ensemble", edge.ensembleMembers, config.mode !== "analysis", config.mode]
    ).catch(() => {});
  }
}

// ── MAIN LOOP ──

async function tick() {
  state.cycleCount++;
  try {
    // Three phases per tick:
    // 1. Discover/refresh temperature markets (every 5 min)
    // 2. Fetch/refresh ensemble forecasts (every 5 min)
    // 3. Scan for edges and execute (every 60s)
    await discoverWeatherMarkets();
    await fetchForecasts();
    await edgeScanCycle();
  } catch (err) {
    logger.error({ module: "agent", err: err.message, stack: err.stack }, "Tick error");
  }
}

export async function startAgent() {
  if (state.running) return;
  state.running = true;

  logger.info({
    module: "agent",
    mode: config.mode,
    cities: Object.keys(CITIES).length,
    strategy: "weather-ensemble",
  }, "Weather Bot starting...");

  // Initial discovery + forecast
  await tick();

  // Main loop: tick every 30s
  const tickInterval = setInterval(async () => {
    if (!state.running) {
      clearInterval(tickInterval);
      return;
    }
    await tick();
  }, 30_000);

  logger.info({ module: "agent", mode: config.mode }, "Weather Bot running");
}

export function stopAgent() {
  state.running = false;
  logger.info({ module: "agent" }, "Weather Bot stopped");
}

export function getState() {
  return {
    running: state.running,
    mode: config.mode,
    strategy: "weather-ensemble",
    cycleCount: state.cycleCount,
    weatherMarkets: state.weatherMarkets.length,
    marketsByCity: Object.fromEntries(
      Object.keys(CITIES).map(code => [
        code,
        state.weatherMarkets.filter(m => m.cityCode === code).length,
      ])
    ),
    forecastStatus: Object.fromEntries(
      Object.entries(state.forecasts).map(([code, f]) => [
        code,
        { members: f.members.length, min: f.members.length > 0 ? Math.min(...f.members).toFixed(1) : null, max: f.members.length > 0 ? Math.max(...f.members).toFixed(1) : null },
      ])
    ),
    detectedEdges: state.detectedEdges.slice(0, 10),
    stats: state.stats,
    lastMarketScan: state.lastMarketScan,
    lastForecastFetch: state.lastForecastFetch,
    lastEdgeScan: state.lastEdgeScan,
    tradeLogToday: state.tradeLog.length,
  };
}

export function getDailyBriefData() {
  return {
    date: new Date().toISOString().split("T")[0],
    mode: config.mode,
    strategy: "weather-ensemble",
    stats: { ...state.stats },
    edges: [...state.detectedEdges],
    tradeLog: [...state.tradeLog],
    weatherMarkets: state.weatherMarkets.length,
    forecasts: Object.fromEntries(
      Object.entries(state.forecasts).map(([code, f]) => [code, f.modelInfo])
    ),
  };
}
