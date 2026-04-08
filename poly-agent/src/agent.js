// ============================================================
// POLY-AGENT: MAIN ORCHESTRATOR (v3 — Math-Based Edge Detection)
//
// Architecture:
//   Two parallel data streams:
//     1. Kalshi prices (every 30s) — what the prediction market thinks
//     2. Bookmaker odds (every 60s) — what sharp money thinks (= fair value)
//   Edge = bookmaker implied probability − Kalshi price − fees
//   No LLM in the hot path. Pure math. Milliseconds per cycle.
//
// Three operating modes:
//   "analysis"    — Detect edges + log, execute nothing
//   "guarded"     — Auto-execute within tight guardrails
//   "autonomous"  — Full auto, circuit breaker is the only gate
//
// Daily brief (separate from hot path):
//   Claude reviews yesterday's trades, edge quality, P&L — that's
//   where human + AI analysis happens, not per-market per-cycle.
// ============================================================

import config from "./config.js";
import logger from "./logger.js";
import * as kalshi from "./execution/kalshi.js";
import { getMarkets as getPolymarketMarkets, getPrice as getPolymarketPrice } from "./execution/polymarket.js";
import { fetchAllOdds } from "./execution/bookmaker.js";
import { findEdges } from "./analysis/edge.js";
import { checkCircuitBreaker } from "./risk/circuit-breaker.js";
import { createProposal, approveProposal } from "./execution/manager.js";
import { evaluateExits as evaluatePositionExits } from "./execution/positions.js";
import { pool } from "./db/schema.js";

// ── STATE ──

const state = {
  watchedMarkets: [],
  latestOdds: new Map(),           // marketId → { yes, no, timestamp }
  bookmakerOdds: [],               // latest bookmaker events from The Odds API
  lastBookmakerPoll: 0,
  lastOddsScan: 0,
  detectedEdges: [],               // current edges found this cycle
  tradeLog: [],                    // trades executed today (for daily brief)
  cycleCount: 0,
  running: false,
  stats: {
    edgesDetected: 0,
    edgesActedOn: 0,
    proposals: 0,
    autoExecuted: 0,
    marketsMatched: 0,             // Kalshi markets matched to bookmaker events
    skippedNoMatch: 0,             // Kalshi markets with no bookmaker equivalent
    bookmakerPolls: 0,
    kalshiPolls: 0,
  },
};

// ── MARKET DISCOVERY ──

async function discoverMarkets() {
  const allMarkets = [];

  // ── Kalshi discovery ──
  if (config.platforms?.kalshi?.enabled) {
    try {
      const markets = await kalshi.getMarkets({ status: "open", limit: 200 });
      for (const m of markets) {
        allMarkets.push({
          id: m.ticker,
          question: m.title || m.subtitle || m.ticker,
          platform: "kalshi",
          sport: m.category || "unknown",
          active: m.status === "open" || m.status === "active",
          lastYesPrice: m.yes_ask != null ? (m.yes_ask > 1 ? m.yes_ask / 100 : m.yes_ask) : (m.last_price != null ? (m.last_price > 1 ? m.last_price / 100 : m.last_price) : 0.5),
          lastNoPrice: m.no_ask != null ? (m.no_ask > 1 ? m.no_ask / 100 : m.no_ask) : 0.5,
          ticker: m.ticker,
          closeTime: m.close_time || m.expiration_time,
          volume: m.volume || 0,
          rawData: m,
        });
      }
      logger.info({ module: "agent", platform: "kalshi", found: allMarkets.filter(m => m.platform === "kalshi").length }, "Kalshi markets discovered");
    } catch (err) {
      logger.error({ module: "agent", platform: "kalshi", err: err.message }, "Kalshi discovery failed");
    }
  }

  // ── Polymarket discovery ──
  if (config.platforms?.polymarket?.enabled) {
    try {
      const enabledSports = config.sports
        ? Object.values(config.sports).filter((s) => s.enabled).map((s) => s.tag)
        : ["nba", "mlb", "nhl"];
      for (const tag of enabledSports) {
        const markets = await getPolymarketMarkets({ tag, limit: 30 });
        for (const m of markets) {
          allMarkets.push({
            id: m.condition_id || m.id,
            question: m.question || m.title,
            platform: "polymarket",
            sport: tag,
            active: m.active,
            lastYesPrice: m.tokens?.[0]?.price || 0,
            lastNoPrice: m.tokens?.[1]?.price || 0,
            tokens: m.tokens,
            condition_id: m.condition_id,
            rawData: m,
          });
        }
      }
      logger.info({ module: "agent", platform: "polymarket", found: allMarkets.filter(m => m.platform === "polymarket").length }, "Polymarket markets discovered");
    } catch (err) {
      logger.error({ module: "agent", platform: "polymarket", err: err.message }, "Polymarket discovery failed");
    }
  }

  // Deduplicate by id
  const seen = new Set();
  state.watchedMarkets = allMarkets.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return m.active;
  });

  logger.info({
    module: "agent",
    watching: state.watchedMarkets.length,
    kalshi: state.watchedMarkets.filter(m => m.platform === "kalshi").length,
    polymarket: state.watchedMarkets.filter(m => m.platform === "polymarket").length,
  }, "Market discovery complete");

  return state.watchedMarkets;
}

// ── BOOKMAKER ODDS POLLING ──

async function bookmakerPollCycle() {
  const now = Date.now();
  const pollMs = config.bookmaker?.pollMs || 60_000;
  if (now - state.lastBookmakerPoll < pollMs) return;
  state.lastBookmakerPoll = now;

  try {
    const events = await fetchAllOdds();
    state.bookmakerOdds = events;
    state.stats.bookmakerPolls++;

    logger.info({
      module: "agent",
      events: events.length,
      sports: [...new Set(events.map(e => e.sport))].join(","),
    }, "Bookmaker odds updated");
  } catch (err) {
    logger.error({ module: "agent", err: err.message }, "Bookmaker poll failed");
  }
}

// ── KALSHI ODDS SCAN + EDGE DETECTION ──

async function oddsScanCycle() {
  const now = Date.now();
  if (now - state.lastOddsScan < config.triggers.oddsPollMs) return;
  state.lastOddsScan = now;
  state.stats.kalshiPolls++;

  // Update prices on watched markets
  for (const market of state.watchedMarkets.slice(0, 50)) {
    const marketId = market.id;
    let price;
    try {
      if (market.platform === "kalshi") {
        price = await kalshi.getPrice(market.ticker);
      } else {
        price = await getPolymarketPrice(market);
      }
    } catch (err) {
      continue;
    }
    if (!price || price.yes == null) continue;

    state.latestOdds.set(marketId, { ...price, timestamp: now });

    // Update the market object with latest prices for edge matching
    market.lastYesPrice = price.yes;
    market.lastNoPrice = price.no;

    // Record to DB (non-blocking)
    if (pool) {
      pool.query(
        `INSERT INTO poly_odds_history (condition_id, yes_price, no_price)
         VALUES ($1, $2, $3)`,
        [marketId, price.yes, price.no]
      ).catch(() => {});
    }
  }

  // ── EDGE DETECTION: Pure math comparison ──
  if (state.bookmakerOdds.length > 0) {
    const edges = findEdges(state.watchedMarkets, state.bookmakerOdds);
    state.detectedEdges = edges;

    if (edges.length > 0) {
      const tradeEligible = edges.filter(e => e.tradeEligible);
      const logOnly = edges.filter(e => !e.tradeEligible);
      state.stats.edgesDetected += edges.length;

      logger.info({
        module: "agent",
        total: edges.length,
        tradeEligible: tradeEligible.length,
        logOnly: logOnly.length,
        topEdge: `${edges[0].ticker} ${edges[0].side} ${edges[0].edgeCents}¢`,
        topFairValue: edges[0].fairValue?.toFixed(3),
        topKalshiPrice: edges[0].kalshiPrice?.toFixed(3),
      }, "Edges detected");

      // Log-only edges (6-6¢ range) get recorded for calibration but never traded
      for (const edge of logOnly) {
        state.tradeLog.push({
          timestamp: Date.now(),
          type: "edge_logged",
          ...edge,
          executed: false,
          reason: "below_trade_threshold",
        });
      }

      // Trade-eligible edges (7¢+) go through the execution pipeline
      for (const edge of tradeEligible) {
        await actOnEdge(edge);
      }
    }
  }

  // ── EVALUATE EXITS on open positions ──
  // Pass bookmaker events so exits can re-compare to fair value
  try {
    await evaluatePositionExits(state.latestOdds, state.bookmakerOdds);
  } catch (err) {
    // Positions module might not have open positions yet
  }
}

// ── EDGE EXECUTION ──

async function actOnEdge(edge) {
  // Safety check: only trade-eligible edges (7¢+) should reach here
  if (!edge.tradeEligible) return;

  const breaker = await checkCircuitBreaker();
  if (!breaker.allowed) {
    logger.warn({ module: "agent", reason: breaker.reason, market: edge.ticker }, "Circuit breaker blocked");
    return;
  }

  const bankroll = breaker.details?.current_bankroll || 1000;

  // Build a proposal-compatible object from the edge
  const proposalData = {
    direction: edge.side === "yes" ? "buy_yes" : "buy_no",
    edge_vs_market: edge.edgeCents,
    fair_value: edge.fairValue,
    confidence: Math.min(0.9, 0.5 + (edge.bookmakerCount / 20)), // More bookmakers = more confidence
    market_price: edge.kalshiPrice,
    reasoning: `Cross-platform edge: ${edge.sharpBook} implies ${(edge.fairValue * 100).toFixed(1)}% vs Kalshi ${(edge.kalshiPrice * 100).toFixed(1)}% (${edge.bookmakerCount} books, ${edge.edgeCents}¢ after fees)`,
    condition_id: edge.marketId,
  };

  const proposal = await createProposal(proposalData, bankroll, breaker.details?.size_multiplier || 1);
  if (!proposal) return;

  state.stats.proposals++;
  state.stats.edgesActedOn++;

  // ── OPERATING MODE ──
  if (config.mode === "analysis") {
    logger.info({
      module: "agent",
      mode: "analysis",
      market: edge.ticker,
      side: edge.side,
      edge: `${edge.edgeCents}¢`,
      fairValue: edge.fairValue?.toFixed(3),
      kalshiPrice: edge.kalshiPrice?.toFixed(3),
      sharpBook: edge.sharpBook,
      books: edge.bookmakerCount,
    }, "Edge logged (analysis mode — no execution)");

    // Log to trade log for daily brief
    state.tradeLog.push({
      timestamp: Date.now(),
      type: "edge_detected",
      ...edge,
      executed: false,
    });

  } else if (config.mode === "guarded") {
    const { maxSizeUsd, minEdgeCents, minConfidence } = config.autoExec;
    const withinGuardrails =
      proposal.size_usd <= maxSizeUsd &&
      edge.edgeCents >= minEdgeCents &&
      proposalData.confidence >= minConfidence;

    if (withinGuardrails) {
      const result = await approveProposal(proposal.id);
      if (result?.success) {
        state.stats.autoExecuted++;
        state.tradeLog.push({ timestamp: Date.now(), type: "executed", ...edge, executed: true });
        logger.info({
          module: "agent",
          mode: "guarded",
          market: edge.ticker,
          side: edge.side,
          edge: `${edge.edgeCents}¢`,
          size: `$${proposal.size_usd}`,
        }, "Auto-executed (within guardrails)");
      }
    } else {
      logger.info({
        module: "agent",
        mode: "guarded",
        market: edge.ticker,
        reason: proposal.size_usd > maxSizeUsd ? "size_exceeds_limit"
          : edge.edgeCents < minEdgeCents ? "edge_below_threshold"
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
        market: edge.ticker,
        edge: `${edge.edgeCents}¢`,
        size: `$${proposal.size_usd}`,
      }, "Auto-executed (autonomous)");
    }
  }

  // Record edge to DB for daily brief analysis
  if (pool) {
    pool.query(
      `INSERT INTO poly_edges (market_id, ticker, side, kalshi_price, fair_value, edge_cents, sharp_book, bookmaker_count, executed, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [edge.marketId, edge.ticker, edge.side, edge.kalshiPrice, edge.fairValue, edge.edgeCents, edge.sharpBook, edge.bookmakerCount, config.mode !== "analysis", config.mode]
    ).catch(() => {});
  }
}

// ── MAIN LOOP ──

async function tick() {
  state.cycleCount++;
  try {
    // Two parallel streams: bookmaker odds + Kalshi prices
    await bookmakerPollCycle();
    await oddsScanCycle();
  } catch (err) {
    logger.error({ module: "agent", err: err.message }, "Tick error");
  }
}

export async function startAgent() {
  if (state.running) return;
  state.running = true;

  const hasOddsApi = !!config.bookmaker?.oddsApiKey;

  logger.info({
    module: "agent",
    mode: config.mode,
    bookmakerEnabled: hasOddsApi,
    exitRules: config.exits,
    triggers: config.triggers,
  }, "Poly-Agent v3 starting (math-based edge detection)...");

  if (!hasOddsApi) {
    logger.warn({ module: "agent" }, "No ODDS_API_KEY — running Kalshi-only without cross-platform comparison. Add ODDS_API_KEY for bookmaker edge detection.");
  }

  await discoverMarkets();
  setInterval(discoverMarkets, 30 * 60 * 1000);

  const tickInterval = setInterval(async () => {
    if (!state.running) {
      clearInterval(tickInterval);
      return;
    }
    await tick();
  }, 15_000);

  await tick();
  logger.info({ module: "agent", mode: config.mode }, "Poly-Agent running");
}

export function stopAgent() {
  state.running = false;
  logger.info({ module: "agent" }, "Poly-Agent stopped");
}

export function getState() {
  return {
    running: state.running,
    mode: config.mode,
    cycleCount: state.cycleCount,
    watchedMarkets: state.watchedMarkets.length,
    latestOdds: Object.fromEntries(state.latestOdds),
    bookmakerEvents: state.bookmakerOdds.length,
    detectedEdges: state.detectedEdges.slice(0, 10), // top 10 for dashboard
    stats: state.stats,
    lastOddsScan: state.lastOddsScan,
    lastBookmakerPoll: state.lastBookmakerPoll,
    exitRules: config.exits,
    autoExec: config.autoExec,
    tradeLogToday: state.tradeLog.length,
  };
}

/**
 * Get today's trade log for daily brief generation.
 */
export function getDailyBriefData() {
  return {
    date: new Date().toISOString().split("T")[0],
    mode: config.mode,
    stats: { ...state.stats },
    edges: [...state.detectedEdges],
    tradeLog: [...state.tradeLog],
    watchedMarkets: state.watchedMarkets.length,
    bookmakerEvents: state.bookmakerOdds.length,
  };
}
