// ============================================================
// REUSABLE QUERY FUNCTIONS
// All writes for briefings, signals, composites.
// ============================================================

import { pool } from "./schema.js";
import logger from "../logger.js";

/**
 * Save a briefing to Postgres.
 */
export async function saveBriefing(briefing) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `INSERT INTO briefings (cycle, timestamp, regime, regime_confidence, overall_sentiment, overall_assessment, briefing_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        briefing.cycle,
        briefing.timestamp,
        briefing.regime,
        briefing.regime_confidence,
        briefing.overall_sentiment,
        briefing.overall_assessment,
        JSON.stringify(briefing),
      ]
    );
    return result.rows[0]?.id;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to save briefing");
    return null;
  }
}

/**
 * Save individual signals from a cycle.
 */
export async function saveSignals(cycle, signals) {
  if (!pool || signals.length === 0) return;
  try {
    for (const s of signals) {
      await pool.query(
        `INSERT INTO signals (cycle, timestamp, pair, signal_type, direction, confidence, regime, thesis, indicators)
         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8)`,
        [
          cycle,
          s.pair,
          s.type,
          s.direction,
          s.confidence,
          s.regime || "unknown",
          s.thesis || "",
          JSON.stringify(s.indicators || {}),
        ]
      );
    }
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to save signals");
  }
}

/**
 * Save composite signals from a cycle.
 */
export async function saveComposites(cycle, composites) {
  if (!pool || composites.length === 0) return;
  try {
    for (const c of composites) {
      await pool.query(
        `INSERT INTO composites (cycle, timestamp, pair, direction, raw_confidence, qualitative_adjustment, final_confidence, regime, signal_count, attribution)
         VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          cycle,
          c.pair,
          c.adjusted_direction || c.direction,
          c.composite_confidence,
          c.qualitative_adjustment || 0,
          c.adjusted_confidence || c.composite_confidence,
          c.regime,
          c.signal_count,
          JSON.stringify(c.attribution || {}),
        ]
      );
    }
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to save composites");
  }
}

/**
 * Get recent briefings for dashboard.
 */
export async function getRecentBriefings(limit = 10) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT id, cycle, timestamp, regime, regime_confidence, overall_sentiment, overall_assessment, briefing_json
       FROM briefings ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to fetch briefings");
    return [];
  }
}

/**
 * Get signal history for a pair (for Phase 2 backtesting).
 */
export async function getSignalHistory(pair, limit = 100) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM signals WHERE pair = $1 ORDER BY timestamp DESC LIMIT $2`,
      [pair, limit]
    );
    return result.rows;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to fetch signal history");
    return [];
  }
}

// ============================================================
// RAW DATA PERSISTENCE (Migration v4)
// Phase 2 backtesting depends on these tables.
// ============================================================

/**
 * Save raw ingestion snapshot for Phase 2 replay.
 */
export async function saveIngestionSnapshot(cycle, points, summary) {
  if (!pool) return null;
  try {
    const sourceCount = Object.keys(summary.bySource || {}).filter(
      (k) => summary.bySource[k]?.status === "ok"
    ).length;
    const result = await pool.query(
      `INSERT INTO ingestion_snapshots (cycle, timestamp, points_json, summary_json, source_count, point_count)
       VALUES ($1, NOW(), $2, $3, $4, $5)
       RETURNING id`,
      [cycle, JSON.stringify(points), JSON.stringify(summary), sourceCount, points.length]
    );
    return result.rows[0]?.id;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to save ingestion snapshot");
    return null;
  }
}

/**
 * Save an arb spread observation.
 */
export async function saveArbObservation(cycle, observation) {
  if (!pool) return null;
  try {
    const { pair, cexPrice, dexPrice, spreadBps } = observation;
    const absBps = Math.abs(spreadBps);
    const signalFired = absBps >= 50;
    const signalStrength = absBps >= 100 ? "strong" : absBps >= 50 ? "alert" : null;

    const result = await pool.query(
      `INSERT INTO arb_observations (cycle, timestamp, pair, cex_price, dex_price, spread_bps, signal_fired, signal_strength)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [cycle, pair, cexPrice, dexPrice, spreadBps, signalFired, signalStrength]
    );
    return result.rows[0]?.id;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to save arb observation");
    return null;
  }
}

/**
 * Save Claude API cost record.
 */
export async function saveApiCost(cycle, costRecord) {
  if (!pool) return null;
  try {
    const { promptType, model, tokensIn, tokensOut, costUsd, latencyMs, promptVersion } = costRecord;
    const result = await pool.query(
      `INSERT INTO api_costs (cycle, timestamp, prompt_type, model, tokens_in, tokens_out, cost_usd, latency_ms, prompt_version)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [cycle, promptType, model, tokensIn, tokensOut, costUsd, latencyMs, promptVersion]
    );
    return result.rows[0]?.id;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to save API cost");
    return null;
  }
}

/**
 * Get arb observations for a pair (for Phase 2 backtesting).
 */
export async function getArbHistory(pair, limit = 500) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM arb_observations WHERE pair = $1 ORDER BY timestamp DESC LIMIT $2`,
      [pair, limit]
    );
    return result.rows;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to fetch arb history");
    return [];
  }
}

/**
 * Get API cost summary for a date range.
 */
export async function getApiCostSummary(days = 7) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT
         model,
         prompt_type,
         COUNT(*) as call_count,
         SUM(tokens_in) as total_tokens_in,
         SUM(tokens_out) as total_tokens_out,
         SUM(cost_usd) as total_cost_usd,
         AVG(latency_ms)::INTEGER as avg_latency_ms
       FROM api_costs
       WHERE timestamp > NOW() - INTERVAL '1 day' * $1
       GROUP BY model, prompt_type
       ORDER BY total_cost_usd DESC`,
      [days]
    );
    return result.rows;
  } catch (e) {
    logger.error({ module: "db", err: e.message }, "Failed to fetch API cost summary");
    return [];
  }
}
