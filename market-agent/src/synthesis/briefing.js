// ============================================================
// BRIEFING ENGINE
// Combines quant signals + qualitative context into
// structured daily briefing. Persists to Postgres.
// ============================================================

import logger from "../logger.js";
import { saveBriefing, saveSignals, saveComposites, getRecentBriefings } from "../db/queries.js";
import { formatBriefing } from "./formatter.js";

// In-memory previous regime for delta tracking (also loaded from DB on first run)
let previousRegime = null;

/**
 * Compute an entry zone for a trade idea based on price, ATR, and direction.
 *
 * @param {Object} composite - Composite signal for a pair
 * @param {Object[]} pairSignals - Individual signals for this pair
 * @returns {Object|null} { low, mid, high } price levels or null
 */
function computeEntryZone(composite, pairSignals) {
  // Find current price from signal indicators
  const priceSignal = pairSignals.find((s) => s.indicators?.price);
  const price = priceSignal?.indicators?.price;
  if (!price || price <= 0) return null;

  // Find ATR if available
  const volSignal = pairSignals.find((s) => s.type === "volatility");
  const atrPct = volSignal?.indicators?.atr_pct;
  const atr = volSignal?.indicators?.atr_14;

  // Default spread: 1% of price if no ATR available
  const spread = atr || price * 0.01;
  const direction = composite.adjusted_direction || composite.direction;

  if (direction === "long") {
    return {
      low: Math.round((price - spread * 1.5) * 100) / 100,
      mid: Math.round(price * 100) / 100,
      high: Math.round((price - spread * 0.5) * 100) / 100,
      note: "Entry zone below current price for long setup",
    };
  } else if (direction === "short") {
    return {
      low: Math.round((price + spread * 0.5) * 100) / 100,
      mid: Math.round(price * 100) / 100,
      high: Math.round((price + spread * 1.5) * 100) / 100,
      note: "Entry zone above current price for short setup",
    };
  }

  return {
    low: Math.round((price - spread) * 100) / 100,
    mid: Math.round(price * 100) / 100,
    high: Math.round((price + spread) * 100) / 100,
    note: "Neutral — no directional entry zone",
  };
}

/**
 * Get the previous regime for delta tracking.
 * Checks in-memory cache first, then falls back to Postgres.
 */
async function getPreviousRegime() {
  if (previousRegime) return previousRegime;

  // Try to load from most recent briefing in DB
  try {
    const recent = await getRecentBriefings(1);
    if (recent.length > 0) {
      const data = recent[0].briefing_json || recent[0];
      previousRegime = data.regime?.current || recent[0].regime || null;
      return previousRegime;
    }
  } catch {
    // DB not available — no delta on first run
  }
  return null;
}

/**
 * Generate a structured briefing from a complete cycle's output.
 *
 * @param {Object} params
 * @param {number} params.cycle - Cycle number
 * @param {Object} params.ingestSummary - Ingestion results summary
 * @param {Object[]} params.signals - Individual signal objects
 * @param {Object[]} params.composites - Adjusted composite signals
 * @param {Object} params.qualSummary - Qualitative analysis summary
 * @returns {Object} Complete briefing object
 */
export async function generateBriefing({ cycle, ingestSummary, signals, composites, qualSummary }) {
  const timestamp = new Date().toISOString();

  // Build trade ideas: ranked setups per pair
  const tradeIdeas = composites
    .filter((c) => c.adjusted_confidence > 0.1 || c.composite_confidence > 0.1)
    .sort((a, b) => (b.adjusted_confidence || b.composite_confidence) - (a.adjusted_confidence || a.composite_confidence))
    .map((c) => {
      const pairSignals = signals.filter((s) => s.pair === c.pair);
      const entryZone = computeEntryZone(c, pairSignals);
      return {
        pair: c.pair,
        direction: c.adjusted_direction || c.direction,
        confidence: c.adjusted_confidence || c.composite_confidence,
        raw_confidence: c.composite_confidence,
        qualitative_adjustment: c.qualitative_adjustment || 0,
        regime: c.regime,
        thesis: buildThesis(c, pairSignals),
        entry_zone: entryZone,
        signal_count: c.signal_count,
        agreement: c.agreement_ratio,
      };
    });

  // Signal conflicts: where quant and qualitative disagree
  const conflicts = [];
  for (const c of composites) {
    if (c.qualitative_adjustment && Math.abs(c.qualitative_adjustment) > 0.1) {
      const quantDir = c.direction;
      const adjDir = c.adjusted_direction || c.direction;
      if (quantDir !== adjDir || Math.abs(c.qualitative_adjustment) > 0.15) {
        conflicts.push({
          pair: c.pair,
          quant_direction: quantDir,
          adjusted_direction: adjDir,
          adjustment: c.qualitative_adjustment,
          rationale: c.qualitative_rationale || "",
        });
      }
    }
  }

  // On-chain highlights from signal data
  const onchainSignals = signals.filter((s) => s.type === "onchain");
  const onchainHighlights = onchainSignals.map((s) => ({
    pair: s.pair,
    thesis: s.thesis,
    indicators: {
      large_transfers: s.indicators?.large_transfer_count || 0,
      accumulating: s.indicators?.is_accumulating || false,
      distributing: s.indicators?.is_distributing || false,
      liquidity_utilization: s.indicators?.liquidity_utilization || null,
      veaero_locks: s.indicators?.veaero_locks || null,
      veaero_unlocks: s.indicators?.veaero_unlocks || null,
      veaero_is_net_locking: s.indicators?.veaero_is_net_locking || null,
    },
  }));

  // Regime delta tracking (S8)
  const prevRegime = await getPreviousRegime();
  const currentRegime = qualSummary?.regime || composites[0]?.regime || "unknown";
  const regimeDelta = prevRegime && prevRegime !== currentRegime
    ? `${prevRegime} → ${currentRegime}`
    : null;

  const briefing = {
    cycle,
    timestamp,
    regime: {
      current: currentRegime,
      previous: prevRegime,
      delta: regimeDelta,
      confidence: qualSummary?.regime_confidence || 0,
      rationale: qualSummary?.regime_rationale || "",
    },
    overall_sentiment: qualSummary?.sentiment || 0,
    overall_assessment: qualSummary?.overall_assessment || "No qualitative analysis available.",
    trade_ideas: tradeIdeas,
    signal_conflicts: conflicts,
    onchain_highlights: onchainHighlights,
    data_sources: ingestSummary?.bySource || {},
    key_themes: qualSummary?.key_themes || [],
    signal_summary: {
      total_signals: signals.length,
      by_type: countByField(signals, "type"),
      by_pair: countByField(signals, "pair"),
    },
  };

  // Update in-memory previous regime for next cycle
  previousRegime = currentRegime;

  // Persist to Postgres
  const briefingId = await saveBriefing(briefing);
  await saveSignals(cycle, signals);
  await saveComposites(cycle, composites);

  if (briefingId) {
    logger.info({ module: "briefing", cycle, id: briefingId }, "Briefing persisted to Postgres");
  }

  // Format for display
  briefing.formatted = formatBriefing(briefing);

  logger.info({
    module: "briefing",
    cycle,
    trade_ideas: tradeIdeas.length,
    conflicts: conflicts.length,
    regime: currentRegime,
    regime_delta: regimeDelta,
  }, "Briefing generated");

  return briefing;
}

/**
 * Build a composite thesis from individual signal theses.
 */
function buildThesis(composite, pairSignals) {
  if (pairSignals.length === 0) return "Insufficient signal data.";
  return pairSignals
    .filter((s) => s.thesis)
    .map((s) => s.thesis)
    .join(" | ");
}

/**
 * Count occurrences of a field value.
 */
function countByField(items, field) {
  const counts = {};
  for (const item of items) {
    const key = item[field] || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
