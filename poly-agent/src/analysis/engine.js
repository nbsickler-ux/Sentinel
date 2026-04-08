// ============================================================
// CLAUDE ANALYSIS ENGINE
// Core prediction engine with calibration tracking.
// Every prediction is recorded for feedback loop optimization.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import config from "../config.js";
import logger from "../logger.js";
import { pool } from "../db/schema.js";
import {
  FAIR_VALUE_SYSTEM,
  OVERREACTION_SYSTEM,
  CORRELATION_SYSTEM,
  PROMPT_VERSION,
  fairValuePrompt,
  overreactionPrompt,
  correlationPrompt,
  newsRelevancePrompt,
} from "./prompts.js";

// ── Pricing for cost tracking ──
const MODEL_PRICING = {
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
};

let client = null;

if (config.anthropic.apiKey) {
  client = new Anthropic({ apiKey: config.anthropic.apiKey });
  logger.info({ module: "analysis" }, "Claude API client initialized");
} else {
  logger.warn({ module: "analysis" }, "ANTHROPIC_API_KEY not set — analysis disabled");
}

/**
 * Call Claude with a specific system prompt and user prompt.
 * Returns parsed JSON + metadata.
 */
async function callClaude(systemPrompt, userPrompt, model) {
  if (!client) return null;

  const start = Date.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: config.anthropic.maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content[0]?.text || "";
    const latency = Date.now() - start;

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ module: "analysis", latency_ms: latency }, "No JSON in Claude response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const tokensIn = response.usage?.input_tokens || 0;
    const tokensOut = response.usage?.output_tokens || 0;
    const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-haiku-4-5-20251001"];
    const costUsd = (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;

    logger.info({
      module: "analysis",
      model,
      latency_ms: latency,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd.toFixed(6),
    }, "Claude analysis complete");

    return { data: parsed, latency_ms: latency, cost_usd: costUsd, tokens: { in: tokensIn, out: tokensOut } };
  } catch (err) {
    logger.error({ module: "analysis", model, err: err.message, latency_ms: Date.now() - start }, "Claude call failed");
    return null;
  }
}

// ── FAIR VALUE ESTIMATION ──

/**
 * Estimate the fair probability for a market.
 * Records the prediction for calibration tracking.
 *
 * @param {Object} params - Market context (see fairValuePrompt)
 * @returns {Object|null} Fair value estimate with metadata
 */
export async function estimateFairValue(params) {
  const prompt = fairValuePrompt(params);
  const result = await callClaude(FAIR_VALUE_SYSTEM, prompt, config.models.fairValue);
  if (!result?.data) return null;

  const estimate = {
    ...result.data,
    market_question: params.market.question,
    condition_id: params.market.conditionId || params.market.condition_id,
    market_yes_price: params.currentOdds.yes,
    market_no_price: params.currentOdds.no,
    model: config.models.fairValue,
    prompt_version: PROMPT_VERSION,
    cost_usd: result.cost_usd,
    latency_ms: result.latency_ms,
    timestamp: Date.now(),
  };

  // Record prediction for calibration (non-blocking)
  recordPrediction(estimate).catch((e) =>
    logger.debug({ module: "analysis", err: e.message }, "Prediction recording failed")
  );

  return estimate;
}

// ── OVERREACTION DETECTION ──

/**
 * Detect if a market move is an overreaction.
 */
export async function detectOverreaction(params) {
  const prompt = overreactionPrompt(params);
  const result = await callClaude(OVERREACTION_SYSTEM, prompt, config.models.overreaction);
  if (!result?.data) return null;

  return {
    ...result.data,
    market_question: params.market.question,
    condition_id: params.market.conditionId || params.market.condition_id,
    price_before: params.priceBefore,
    price_now: params.priceNow,
    model: config.models.overreaction,
    cost_usd: result.cost_usd,
    timestamp: Date.now(),
  };
}

// ── CROSS-MARKET CORRELATION ──

/**
 * Identify all markets affected by a single news event.
 */
export async function findCorrelatedMarkets(params) {
  const prompt = correlationPrompt(params);
  const result = await callClaude(CORRELATION_SYSTEM, prompt, config.models.correlation);
  if (!result?.data) return null;

  return {
    ...result.data,
    news_event: params.newsEvent.title,
    model: config.models.correlation,
    cost_usd: result.cost_usd,
    timestamp: Date.now(),
  };
}

// ── NEWS RELEVANCE FILTER ──

/**
 * Quick check: does this news item affect any watched markets?
 * Uses Haiku for speed — needs to run on every news item.
 */
export async function scoreNewsRelevance(params) {
  const prompt = newsRelevancePrompt(params);
  const result = await callClaude(FAIR_VALUE_SYSTEM, prompt, config.models.newsRelevance);
  return result?.data || null;
}

// ── CALIBRATION TRACKING ──
// Every prediction is recorded. After resolution, we compare
// our estimate to the actual outcome. This is the moat.

/**
 * Record a prediction for calibration analysis.
 */
async function recordPrediction(estimate) {
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO poly_predictions (
        condition_id, market_question, fair_probability, confidence,
        edge_vs_market, direction, market_yes_price, market_no_price,
        model, prompt_version, cost_usd, key_factors, rationale,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
      [
        estimate.condition_id,
        estimate.market_question,
        estimate.fair_probability,
        estimate.confidence,
        estimate.edge_vs_market,
        estimate.direction,
        estimate.market_yes_price,
        estimate.market_no_price,
        estimate.model,
        estimate.prompt_version,
        estimate.cost_usd,
        JSON.stringify(estimate.key_factors || []),
        estimate.rationale || "",
      ]
    );
  } catch (err) {
    // Table might not exist yet — that's ok in dev
    logger.debug({ module: "analysis", err: err.message }, "Prediction insert failed");
  }
}

/**
 * Record the actual outcome for a resolved market.
 * Called when a market resolves — updates calibration data.
 */
export async function recordOutcome(conditionId, outcome) {
  if (!pool) return;

  try {
    await pool.query(
      `UPDATE poly_predictions
       SET actual_outcome = $2, resolved_at = NOW()
       WHERE condition_id = $1 AND actual_outcome IS NULL`,
      [conditionId, outcome ? 1.0 : 0.0]
    );
    logger.info({ module: "analysis", conditionId, outcome }, "Outcome recorded for calibration");
  } catch (err) {
    logger.error({ module: "analysis", err: err.message }, "Outcome recording failed");
  }
}

/**
 * Get calibration statistics.
 * Buckets predictions by confidence and compares to actual outcomes.
 *
 * @returns {Object} Calibration data with Brier score, bucket accuracy, and bias
 */
export async function getCalibrationStats() {
  if (!pool) return null;

  try {
    // Overall Brier score
    const { rows: brierRows } = await pool.query(
      `SELECT
        COUNT(*) as total_predictions,
        AVG(POWER(fair_probability - actual_outcome, 2)) as brier_score,
        AVG(fair_probability) as avg_predicted,
        AVG(actual_outcome) as avg_actual
       FROM poly_predictions
       WHERE actual_outcome IS NOT NULL`
    );

    // Bucketed calibration (10% buckets)
    const { rows: bucketRows } = await pool.query(
      `SELECT
        FLOOR(fair_probability * 10) / 10 as bucket,
        COUNT(*) as count,
        AVG(fair_probability) as avg_predicted,
        AVG(actual_outcome) as avg_actual,
        AVG(fair_probability) - AVG(actual_outcome) as bias
       FROM poly_predictions
       WHERE actual_outcome IS NOT NULL
       GROUP BY FLOOR(fair_probability * 10) / 10
       ORDER BY bucket`
    );

    // Recent accuracy trend (last 50 predictions)
    const { rows: trendRows } = await pool.query(
      `SELECT
        condition_id, market_question, fair_probability,
        actual_outcome, confidence, direction,
        ABS(fair_probability - actual_outcome) as error,
        created_at, resolved_at
       FROM poly_predictions
       WHERE actual_outcome IS NOT NULL
       ORDER BY resolved_at DESC
       LIMIT 50`
    );

    // Model-specific performance
    const { rows: modelRows } = await pool.query(
      `SELECT
        model,
        COUNT(*) as count,
        AVG(POWER(fair_probability - actual_outcome, 2)) as brier_score,
        AVG(ABS(fair_probability - actual_outcome)) as avg_error
       FROM poly_predictions
       WHERE actual_outcome IS NOT NULL
       GROUP BY model`
    );

    return {
      overall: brierRows[0] || {},
      buckets: bucketRows,
      recentTrend: trendRows,
      byModel: modelRows,
      fetchedAt: Date.now(),
    };
  } catch (err) {
    logger.error({ module: "analysis", err: err.message }, "Calibration stats query failed");
    return null;
  }
}
