// ============================================================
// CALIBRATION TRACKER
// Records model predictions vs market settlements.
// Computes Brier score, calibration curves, and accuracy metrics.
//
// This is the core feedback loop: if the model is well-calibrated,
// we scale up. If it's not, we investigate before risking more.
//
// Key metrics:
//   Brier score: mean((predicted_prob - actual_outcome)²)
//     < 0.10 = excellent, < 0.15 = good, > 0.25 = bad
//   Calibration: do 80% predictions actually hit 80% of the time?
//   Sharpness: are predictions spread out (good) or clustered at 50% (useless)?
// ============================================================

import { pool } from "../db/schema.js";
import logger from "../logger.js";

/**
 * Record a prediction for later calibration scoring.
 * Called every time the bot computes an edge — regardless of whether it trades.
 *
 * @param {Object} prediction
 * @param {string} prediction.ticker - Kalshi market ticker
 * @param {string} prediction.cityCode - City code (NYC, CHI, etc.)
 * @param {string} prediction.bracketLabel - Human-readable bracket
 * @param {number} prediction.modelProb - Our model's probability (0-1)
 * @param {number} prediction.marketPrice - Kalshi market price at time of prediction
 * @param {number} prediction.ensembleMembers - Number of ensemble members used
 * @param {string} prediction.side - buy_yes or sell_yes
 * @param {number} prediction.netEdgeCents - Net edge after fees
 * @param {boolean} prediction.traded - Whether we actually placed a trade
 */
export async function recordPrediction(prediction) {
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO weather_predictions (
        ticker, city_code, bracket_label, bracket_low, bracket_high,
        model_prob, market_price, ensemble_members, side, net_edge_cents,
        traded, target_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        prediction.ticker,
        prediction.cityCode,
        prediction.bracketLabel,
        prediction.bracketLow ?? null,
        prediction.bracketHigh ?? null,
        prediction.modelProb,
        prediction.marketPrice,
        prediction.ensembleMembers,
        prediction.side,
        prediction.netEdgeCents,
        prediction.traded || false,
        prediction.targetDate || null,
      ]
    );
  } catch (err) {
    logger.error({ module: "calibration", err: err.message }, "Failed to record prediction");
  }
}

/**
 * Record a settlement outcome.
 * Called when NWS data comes in and we know the actual high temperature.
 *
 * @param {string} cityCode - City code
 * @param {string} targetDate - Date the forecast was for (YYYY-MM-DD)
 * @param {number} actualHigh - Actual high temperature (°F)
 */
export async function recordSettlement(cityCode, targetDate, actualHigh) {
  if (!pool) return;

  try {
    // Update all predictions for this city/date with the actual outcome
    // A prediction "wins" if the actual temp falls in the predicted bracket
    const { rowCount } = await pool.query(
      `UPDATE weather_predictions
       SET actual_high = $1,
           outcome = CASE
             WHEN bracket_low IS NULL AND $1 < bracket_high THEN 1.0
             WHEN bracket_high IS NULL AND $1 >= bracket_low THEN 1.0
             WHEN $1 >= bracket_low AND $1 < bracket_high THEN 1.0
             ELSE 0.0
           END,
           settled_at = NOW()
       WHERE city_code = $2 AND target_date = $3 AND outcome IS NULL`,
      [actualHigh, cityCode, targetDate]
    );

    logger.info({
      module: "calibration",
      cityCode,
      targetDate,
      actualHigh,
      predictionsUpdated: rowCount,
    }, "Settlement recorded");
  } catch (err) {
    logger.error({ module: "calibration", err: err.message }, "Failed to record settlement");
  }
}

/**
 * Compute Brier score and calibration metrics.
 * Brier score = mean((predicted_prob - actual_outcome)²)
 *
 * @param {Object} opts - { days: number } how many days back to look
 * @returns {Object} Calibration summary
 */
export async function getCalibrationReport(opts = {}) {
  if (!pool) return null;

  const days = opts.days || 30;

  try {
    // Overall Brier score
    const { rows: brierRows } = await pool.query(`
      SELECT
        COUNT(*) as total_predictions,
        COUNT(*) FILTER (WHERE traded) as traded_predictions,
        AVG(POWER(model_prob - outcome, 2)) as brier_score,
        AVG(POWER(model_prob - outcome, 2)) FILTER (WHERE traded) as brier_traded,
        AVG(POWER(market_price - outcome, 2)) as market_brier,
        AVG(ABS(model_prob - outcome)) as mae,
        COUNT(*) FILTER (WHERE
          (side = 'buy_yes' AND outcome = 1) OR
          (side = 'sell_yes' AND outcome = 0)
        ) as correct_side,
        COUNT(*) FILTER (WHERE outcome IS NOT NULL) as resolved
      FROM weather_predictions
      WHERE settled_at > NOW() - INTERVAL '${days} days'
        AND outcome IS NOT NULL
    `);

    const overall = brierRows[0];

    // Calibration by probability bucket
    // Groups predictions into 10% buckets and checks actual hit rate
    const { rows: buckets } = await pool.query(`
      SELECT
        FLOOR(model_prob * 10) / 10 as bucket_start,
        COUNT(*) as count,
        AVG(model_prob) as avg_predicted,
        AVG(outcome) as avg_actual,
        ABS(AVG(model_prob) - AVG(outcome)) as calibration_error
      FROM weather_predictions
      WHERE settled_at > NOW() - INTERVAL '${days} days'
        AND outcome IS NOT NULL
      GROUP BY FLOOR(model_prob * 10)
      ORDER BY bucket_start
    `);

    // By city
    const { rows: byCityRows } = await pool.query(`
      SELECT
        city_code,
        COUNT(*) as predictions,
        AVG(POWER(model_prob - outcome, 2)) as brier_score,
        COUNT(*) FILTER (WHERE
          (side = 'buy_yes' AND outcome = 1) OR
          (side = 'sell_yes' AND outcome = 0)
        ) as correct_side
      FROM weather_predictions
      WHERE settled_at > NOW() - INTERVAL '${days} days'
        AND outcome IS NOT NULL
      GROUP BY city_code
      ORDER BY city_code
    `);

    // Daily P&L from settled trades
    const { rows: dailyPnl } = await pool.query(`
      SELECT
        target_date,
        COUNT(*) as trades,
        COUNT(*) FILTER (WHERE
          (side = 'buy_yes' AND outcome = 1) OR
          (side = 'sell_yes' AND outcome = 0)
        ) as wins,
        SUM(CASE
          WHEN side = 'sell_yes' AND outcome = 0 THEN market_price - 0.07 * market_price * (1 - market_price)
          WHEN side = 'buy_yes' AND outcome = 1 THEN (1 - market_price) - 0.07 * market_price * (1 - market_price)
          WHEN side = 'sell_yes' AND outcome = 1 THEN -(1 - market_price)
          WHEN side = 'buy_yes' AND outcome = 0 THEN -market_price
          ELSE 0
        END) as estimated_pnl_per_contract
      FROM weather_predictions
      WHERE settled_at > NOW() - INTERVAL '${days} days'
        AND outcome IS NOT NULL
        AND traded = true
      GROUP BY target_date
      ORDER BY target_date DESC
    `);

    const resolved = parseInt(overall.resolved) || 0;
    const correctSide = parseInt(overall.correct_side) || 0;

    const report = {
      period: `${days} days`,
      totalPredictions: parseInt(overall.total_predictions) || 0,
      resolvedPredictions: resolved,
      tradedPredictions: parseInt(overall.traded_predictions) || 0,

      // Brier scores (lower = better)
      brierScore: overall.brier_score ? parseFloat(overall.brier_score).toFixed(4) : null,
      brierTraded: overall.brier_traded ? parseFloat(overall.brier_traded).toFixed(4) : null,
      marketBrier: overall.market_brier ? parseFloat(overall.market_brier).toFixed(4) : null,
      modelBeatsMarket: overall.brier_score && overall.market_brier
        ? parseFloat(overall.brier_score) < parseFloat(overall.market_brier)
        : null,

      // Accuracy
      sideAccuracy: resolved > 0 ? `${(correctSide / resolved * 100).toFixed(1)}%` : null,
      mae: overall.mae ? parseFloat(overall.mae).toFixed(4) : null,

      // Calibration curve
      calibrationBuckets: buckets.map(b => ({
        range: `${(parseFloat(b.bucket_start) * 100).toFixed(0)}-${(parseFloat(b.bucket_start) * 100 + 10).toFixed(0)}%`,
        count: parseInt(b.count),
        predicted: parseFloat(b.avg_predicted).toFixed(3),
        actual: parseFloat(b.avg_actual).toFixed(3),
        error: parseFloat(b.calibration_error).toFixed(3),
      })),

      // By city
      byCity: byCityRows.map(c => ({
        city: c.city_code,
        predictions: parseInt(c.predictions),
        brierScore: parseFloat(c.brier_score).toFixed(4),
        accuracy: `${(parseInt(c.correct_side) / parseInt(c.predictions) * 100).toFixed(1)}%`,
      })),

      // Daily P&L
      dailyPnl: dailyPnl.map(d => ({
        date: d.target_date,
        trades: parseInt(d.trades),
        wins: parseInt(d.wins),
        winRate: `${(parseInt(d.wins) / parseInt(d.trades) * 100).toFixed(0)}%`,
        estPnlPerContract: parseFloat(d.estimated_pnl_per_contract).toFixed(4),
      })),

      // Scaling recommendation
      scalingRecommendation: getScalingRecommendation(overall, resolved, correctSide),
    };

    logger.info({
      module: "calibration",
      brier: report.brierScore,
      accuracy: report.sideAccuracy,
      resolved: report.resolvedPredictions,
      beatsMarket: report.modelBeatsMarket,
    }, "Calibration report generated");

    return report;
  } catch (err) {
    logger.error({ module: "calibration", err: err.message }, "Calibration report failed");
    return null;
  }
}

/**
 * Based on calibration metrics, recommend sizing level.
 */
function getScalingRecommendation(stats, resolved, correctSide) {
  if (resolved < 10) {
    return { level: "initial", kelly: 0.25, maxPct: 0.04, reason: "Insufficient data (<10 settlements)" };
  }

  const brier = parseFloat(stats.brier_score);
  const accuracy = correctSide / resolved;

  if (brier < 0.10 && accuracy > 0.65 && resolved >= 30) {
    return { level: "aggressive", kelly: 0.50, maxPct: 0.06, reason: `Excellent calibration: Brier ${brier.toFixed(3)}, accuracy ${(accuracy*100).toFixed(0)}%` };
  }

  if (brier < 0.15 && accuracy > 0.58 && resolved >= 15) {
    return { level: "moderate", kelly: 0.35, maxPct: 0.05, reason: `Good calibration: Brier ${brier.toFixed(3)}, accuracy ${(accuracy*100).toFixed(0)}%` };
  }

  if (brier < 0.25 && accuracy > 0.50) {
    return { level: "conservative", kelly: 0.25, maxPct: 0.04, reason: `Acceptable calibration: Brier ${brier.toFixed(3)}, accuracy ${(accuracy*100).toFixed(0)}%` };
  }

  return { level: "pause", kelly: 0, maxPct: 0, reason: `Poor calibration: Brier ${brier.toFixed(3)}, accuracy ${(accuracy*100).toFixed(0)}%. Investigate before trading.` };
}

/**
 * Initialize calibration table.
 */
export async function initCalibrationTable() {
  if (!pool) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS weather_predictions (
        id SERIAL PRIMARY KEY,
        ticker TEXT NOT NULL,
        city_code TEXT NOT NULL,
        bracket_label TEXT,
        bracket_low REAL,
        bracket_high REAL,
        model_prob REAL NOT NULL,
        market_price REAL NOT NULL,
        ensemble_members INTEGER,
        side TEXT NOT NULL,
        net_edge_cents REAL,
        traded BOOLEAN DEFAULT FALSE,
        target_date DATE,
        actual_high REAL,
        outcome REAL,  -- 1.0 if bracket hit, 0.0 if not, NULL if unsettled
        created_at TIMESTAMPTZ DEFAULT NOW(),
        settled_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_wp_city_date ON weather_predictions(city_code, target_date);
      CREATE INDEX IF NOT EXISTS idx_wp_settled ON weather_predictions(settled_at) WHERE outcome IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_wp_ticker ON weather_predictions(ticker);
    `);

    logger.info({ module: "calibration" }, "Calibration table initialized");
  } catch (err) {
    // Table might already exist — that's fine
    if (!err.message.includes("already exists")) {
      logger.error({ module: "calibration", err: err.message }, "Calibration table init failed");
    }
  }
}
