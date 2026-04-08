// ============================================================
// POLY-AGENT: MAIN ORCHESTRATOR (v2 — Event-Driven)
//
// Three operating modes:
//   "analysis"   — Predict + log everything, execute nothing
//   "guarded"    — Auto-execute within tight guardrails
//   "autonomous"  — Full auto, circuit breaker is the only gate
//
// Analysis triggers (replaces fixed 5-min intervals):
//   - Price move > 3¢ since last analysis
//   - High-impact news/injury detected
//   - Approaching game time (pre-game window)
//   - Stale analysis (>30 min with no trigger)
//
// Position management:
//   - Profit target: +8¢ move in our favor → exit
//   - Edge compressed: remaining edge < 2¢ → exit
//   - Stop loss: -12¢ against → exit
//   - Analysis reversal: Claude flips direction → exit
// ============================================================

import config from "./config.js";
import logger from "./logger.js";
import { getMarkets, getPrice } from "./execution/polymarket.js";
import { fetchAllNews } from "./ingest/news.js";
import {
  estimateFairValue,
  detectOverreaction,
  findCorrelatedMarkets,
  scoreNewsRelevance,
} from "./analysis/engine.js";
import { checkCircuitBreaker } from "./risk/circuit-breaker.js";
import { createProposal, getPendingProposals, approveProposal } from "./execution/manager.js";
import { evaluateExits, getPerformanceSummary } from "./execution/positions.js";
import { pool } from "./db/schema.js";

// ── STATE ──

const state = {
  watchedMarkets: [],
  latestNews: null,
  latestOdds: new Map(),         // condition_id → { yes, no, timestamp }
  previousOdds: new Map(),       // condition_id → previous snapshot
  analysisResults: new Map(),    // condition_id → latest fair value estimate
  lastAnalysisTime: new Map(),   // condition_id → timestamp of last analysis
  lastAnalysisPrice: new Map(),  // condition_id → price at time of last analysis
  cycleCount: 0,
  lastNewsScan: 0,
  lastOddsScan: 0,
  running: false,
  stats: {
    predictions: 0,
    proposals: 0,
    autoExecuted: 0,
    overreactions: 0,
    correlations: 0,
    skippedNoTrigger: 0,
    totalCostUsd: 0,
  },
};

// ── MARKET DISCOVERY ──

async function discoverMarkets() {
  // Pull tags from config — covers everything from NBA to esports to F1
  const enabledSports = config.sports
    ? Object.values(config.sports).filter((s) => s.enabled).map((s) => s.tag)
    : ["nba", "mlb", "nhl"];
  const allMarkets = [];

  for (const tag of enabledSports) {
    const markets = await getMarkets({ tag, limit: 30 });
    allMarkets.push(...markets.map((m) => ({ ...m, sport: tag })));
  }

  // Deduplicate
  const seen = new Set();
  state.watchedMarkets = allMarkets.filter((m) => {
    const id = m.condition_id || m.id;
    if (seen.has(id)) return false;
    seen.add(id);
    return m.active && m.tokens?.length >= 2;
  });

  logger.info({
    module: "agent",
    watching: state.watchedMarkets.length,
  }, "Market discovery complete");

  return state.watchedMarkets;
}

// ── TRIGGER LOGIC ──

/**
 * Determine if a market needs re-analysis based on event triggers.
 * Returns { shouldAnalyze, reason } — saves API calls by skipping
 * markets where nothing has changed.
 */
function shouldAnalyzeMarket(conditionId, currentPrice) {
  const now = Date.now();
  const lastTime = state.lastAnalysisTime.get(conditionId) || 0;
  const lastPrice = state.lastAnalysisPrice.get(conditionId);
  const timeSinceAnalysis = now - lastTime;

  // Never analyzed → always analyze
  if (!lastTime) {
    return { shouldAnalyze: true, reason: "first_analysis" };
  }

  // Find the market for game-time proximity check
  const market = state.watchedMarkets.find((m) => m.condition_id === conditionId);
  const endDate = market?.endDate || market?.end_date_iso;
  const hoursToResolution = endDate
    ? (new Date(endDate).getTime() - now) / (1000 * 60 * 60)
    : Infinity;

  // Pre-game window: more sensitive trigger
  const inPreGame = hoursToResolution <= config.triggers.preGameWindowHours && hoursToResolution > 0;
  const triggerCents = inPreGame
    ? config.triggers.preGameTriggerCents
    : config.triggers.priceMoveTriggerCents;

  // Price move trigger
  if (lastPrice != null && currentPrice != null) {
    const moveCents = Math.abs(currentPrice - lastPrice) * 100;
    if (moveCents >= triggerCents) {
      return {
        shouldAnalyze: true,
        reason: inPreGame
          ? `pre_game_move_${moveCents.toFixed(1)}c`
          : `price_move_${moveCents.toFixed(1)}c`,
      };
    }
  }

  // Stale analysis
  if (timeSinceAnalysis >= config.triggers.staleAnalysisMs) {
    return { shouldAnalyze: true, reason: "stale" };
  }

  return { shouldAnalyze: false, reason: "no_trigger" };
}

// ── NEWS SCAN ──

async function newsScanCycle() {
  const now = Date.now();
  if (now - state.lastNewsScan < config.triggers.newsPollMs) return;
  state.lastNewsScan = now;

  const news = await fetchAllNews(["nba", "mlb", "nhl"]);
  state.latestNews = news;

  // Filter headlines for relevance (limit to control API cost)
  const toCheck = news.headlines.slice(0, 10);
  const relevantNews = [];

  for (const headline of toCheck) {
    const relevance = await scoreNewsRelevance({
      newsItem: headline,
      watchedMarkets: state.watchedMarkets.slice(0, 15),
    });
    if (relevance?.relevant && relevance.impact_magnitude !== "none") {
      relevantNews.push({ headline, relevance });
    }
  }

  // High-impact news → trigger correlation + immediate analysis
  for (const { headline, relevance } of relevantNews) {
    if (relevance.impact_magnitude === "high") {
      await handleHighImpactEvent(headline);
    }
  }

  // Critical injuries → same treatment
  for (const injury of news.injuries) {
    if (injury.status === "Out" || injury.status === "Doubtful") {
      const event = {
        title: `${injury.player} (${injury.team}) ruled ${injury.status}`,
        description: injury.detail || injury.type,
        detail: `Game: ${injury.event}, Date: ${injury.gameDate}`,
      };
      await handleHighImpactEvent(event);
    }
  }

  logger.info({
    module: "agent",
    headlines: news.headlines.length,
    injuries: news.injuries.length,
    relevant: relevantNews.length,
  }, "News scan complete");
}

/**
 * Handle a high-impact news event: find all affected markets,
 * trigger immediate re-analysis on each.
 */
async function handleHighImpactEvent(newsEvent) {
  logger.info({
    module: "agent",
    event: newsEvent.title?.slice(0, 80),
  }, "High-impact event — running correlation analysis");

  const correlated = await findCorrelatedMarkets({
    newsEvent,
    activeMarkets: state.watchedMarkets.slice(0, 25).map((m) => ({
      conditionId: m.condition_id,
      question: m.question,
      yesPrice: parseFloat(m.outcomePrices?.[0] || 0.5),
    })),
  });

  state.stats.correlations++;

  if (correlated?.affected_markets?.length > 0) {
    logger.info({
      module: "agent",
      affected: correlated.affected_markets.length,
      urgency: correlated.urgency,
    }, "Correlated markets identified — triggering analysis");

    for (const affected of correlated.affected_markets) {
      const market = state.watchedMarkets.find(
        (m) => m.condition_id?.startsWith(affected.condition_id)
      );
      if (market) {
        // Force analysis regardless of trigger (this IS the trigger)
        await analyzeMarket(market, true);
      }
    }
  }
}

// ── ODDS SCAN + EXIT EVALUATION ──

async function oddsScanCycle() {
  const now = Date.now();
  if (now - state.lastOddsScan < config.triggers.oddsPollMs) return;
  state.lastOddsScan = now;

  // Update prices on watched markets
  for (const market of state.watchedMarkets.slice(0, 20)) {
    const condId = market.condition_id;
    const price = await getPrice(market);
    if (!price || price.yes == null) continue;

    const prev = state.latestOdds.get(condId);
    if (prev) state.previousOdds.set(condId, prev);
    state.latestOdds.set(condId, price);

    // Record to DB (non-blocking)
    if (pool) {
      pool.query(
        `INSERT INTO poly_odds_history (condition_id, yes_price, no_price)
         VALUES ($1, $2, $3)`,
        [condId, price.yes, price.no]
      ).catch(() => {});
    }

    // Check for significant moves → overreaction detection
    if (prev) {
      const moveCents = Math.abs(price.yes - prev.yes) * 100;
      if (moveCents > 5) {
        const minutesSince = (now - prev.timestamp) / 60_000;
        const overreaction = await detectOverreaction({
          market: { question: market.question, conditionId: condId },
          priceBefore: prev.yes,
          priceNow: price.yes,
          minutesSinceMove: Math.round(minutesSince),
          newsContent: state.latestNews?.headlines?.[0]?.title || null,
        });

        if (overreaction?.reversion_expected) {
          state.stats.overreactions++;
          logger.info({
            module: "agent",
            market: market.question?.slice(0, 60),
            assessment: overreaction.assessment,
            reversion: `${overreaction.reversion_magnitude_cents}¢`,
          }, "Overreaction detected");
          await analyzeMarket(market, true); // Force analysis
        }
      }
    }

    // EVENT-DRIVEN: Check if this market needs re-analysis
    const trigger = shouldAnalyzeMarket(condId, price.yes);
    if (trigger.shouldAnalyze) {
      await analyzeMarket(market, false);
    } else {
      state.stats.skippedNoTrigger++;
    }
  }

  // ── EVALUATE EXITS on open positions ──
  await evaluateExits(state.latestOdds, state.analysisResults);
}

// ── MARKET ANALYSIS ──

/**
 * Run Claude analysis on a single market.
 * Creates proposals or auto-executes depending on operating mode.
 */
async function analyzeMarket(market, forced = false) {
  const condId = market.condition_id;
  const odds = state.latestOdds.get(condId);
  if (!odds) return null;

  // Build context
  const headlines = (state.latestNews?.headlines || []).slice(0, 5);
  const injuries = (state.latestNews?.injuries || []).filter((i) => {
    const q = (market.question || "").toLowerCase();
    return q.includes((i.team || "").toLowerCase()) || q.includes((i.player || "").toLowerCase());
  });

  const estimate = await estimateFairValue({
    market: {
      question: market.question,
      conditionId: condId,
      endDate: market.endDate || market.end_date_iso,
      category: market.category || "sports",
    },
    currentOdds: { yes: odds.yes, no: odds.no },
    news: headlines,
    injuries,
    scoreboard: null,
  });

  if (!estimate) return null;

  // Record analysis state
  state.analysisResults.set(condId, estimate);
  state.lastAnalysisTime.set(condId, Date.now());
  state.lastAnalysisPrice.set(condId, odds.yes);
  state.stats.predictions++;

  // ── DECISION: Does this estimate warrant a trade? ──
  const hasEdge =
    estimate.direction !== "no_trade" &&
    Math.abs(estimate.edge_vs_market) >= config.risk.minEdgeCents;

  if (!hasEdge) return estimate;

  const breaker = await checkCircuitBreaker();
  if (!breaker.allowed) {
    logger.warn({ module: "agent", reason: breaker.reason }, "Circuit breaker blocked");
    return estimate;
  }

  const bankroll = breaker.details.current_bankroll || 1000;
  const proposal = await createProposal(estimate, bankroll, breaker.details.size_multiplier);
  if (!proposal) return estimate;

  state.stats.proposals++;

  // ── OPERATING MODE DETERMINES WHAT HAPPENS NEXT ──

  if (config.mode === "analysis") {
    // Analysis mode: log proposal, don't execute
    logger.info({
      module: "agent",
      mode: "analysis",
      market: market.question?.slice(0, 60),
      direction: estimate.direction,
      edge: `${estimate.edge_vs_market.toFixed(1)}¢`,
      size: `$${proposal.size_usd}`,
    }, "Proposal logged (analysis mode — no execution)");

  } else if (config.mode === "guarded") {
    // Guarded mode: auto-execute if within guardrails
    const { maxSizeUsd, minEdgeCents, minConfidence } = config.autoExec;

    const withinGuardrails =
      proposal.size_usd <= maxSizeUsd &&
      proposal.edge_cents >= minEdgeCents &&
      proposal.confidence >= minConfidence;

    if (withinGuardrails) {
      const result = await approveProposal(proposal.id);
      if (result.success) {
        state.stats.autoExecuted++;
        logger.info({
          module: "agent",
          mode: "guarded",
          market: market.question?.slice(0, 60),
          size: `$${proposal.size_usd}`,
          edge: `${proposal.edge_cents.toFixed(1)}¢`,
        }, "Auto-executed (within guardrails)");
      }
    } else {
      logger.info({
        module: "agent",
        mode: "guarded",
        market: market.question?.slice(0, 60),
        reason: proposal.size_usd > maxSizeUsd ? "size_exceeds_limit"
          : proposal.edge_cents < minEdgeCents ? "edge_below_threshold"
          : "confidence_below_threshold",
      }, "Proposal held for review (outside guardrails)");
    }

  } else if (config.mode === "autonomous") {
    // Autonomous: execute everything the circuit breaker allows
    const result = await approveProposal(proposal.id);
    if (result.success) {
      state.stats.autoExecuted++;
      logger.info({
        module: "agent",
        mode: "autonomous",
        market: market.question?.slice(0, 60),
        size: `$${proposal.size_usd}`,
        edge: `${proposal.edge_cents.toFixed(1)}¢`,
      }, "Auto-executed (autonomous)");
    }
  }

  return estimate;
}

// ── MAIN LOOP ──

async function tick() {
  state.cycleCount++;
  try {
    await newsScanCycle();
    await oddsScanCycle();
    // No more fixed fullAnalysisCycle — analysis is event-driven from oddsScanCycle
  } catch (err) {
    logger.error({ module: "agent", err: err.message }, "Tick error");
  }
}

export async function startAgent() {
  if (state.running) return;
  state.running = true;

  logger.info({
    module: "agent",
    mode: config.mode,
    exitRules: config.exits,
    triggers: config.triggers,
  }, "Poly-Agent starting...");

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
    analysisResults: Object.fromEntries(state.analysisResults),
    stats: state.stats,
    lastNewsScan: state.lastNewsScan,
    lastOddsScan: state.lastOddsScan,
    newsCount: state.latestNews?.headlines?.length || 0,
    injuryCount: state.latestNews?.injuries?.length || 0,
    exitRules: config.exits,
    autoExec: config.autoExec,
    triggers: config.triggers,
  };
}
