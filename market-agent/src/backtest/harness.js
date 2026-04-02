// ============================================================
// BACKTESTING HARNESS
// Replays historical data through signal engines.
// Starts with arb signal (has inputPrices/inputHistory params).
// Expands to directional signals via price history buffer.
// ============================================================

import crypto from "crypto";
import logger from "../logger.js";
import { pool } from "../db/schema.js";
import { loadPrices, loadArbObservations, getDateRange } from "./loader.js";
import { simulateTrade, DEFAULT_PARAMS, arbFeeBps } from "./simulator.js";
import { computeMetrics, checkGraduation } from "./metrics.js";
import { analyze as arbAnalyze } from "../signals/arbitrage.js";
import { analyze as trendAnalyze } from "../signals/trend.js";
import { analyze as reversionAnalyze } from "../signals/reversion.js";
import { analyze as volatilityAnalyze } from "../signals/volatility.js";
import { computeComposite } from "../signals/scorer.js";

/**
 * Run arb signal backtest against historical spread data.
 *
 * @param {string} pair
 * @param {Object} options - { startDate, endDate, positionSizeUsd, params }
 */
export async function backtestArb(pair, options = {}) {
  const positionSize = options.positionSizeUsd || 1000;
  const params = { ...DEFAULT_PARAMS.arb, ...options.params };

  // Load CEX prices (for future price lookup after signal)
  const cexPrices = await loadPrices(pair, "coinbase", options.startDate, options.endDate);
  const dexPrices = await loadPrices(pair, "aerodrome", options.startDate, options.endDate);

  if (cexPrices.length === 0 || dexPrices.length === 0) {
    logger.warn({ module: "backtest", pair }, "Insufficient data for arb backtest");
    return { trades: [], metrics: computeMetrics([]), pair, signalType: "arbitrage" };
  }

  logger.info({
    module: "backtest",
    pair,
    cexPoints: cexPrices.length,
    dexPoints: dexPrices.length,
    dateRange: `${cexPrices[0].timestamp.toISOString().slice(0, 10)} → ${cexPrices[cexPrices.length - 1].timestamp.toISOString().slice(0, 10)}`,
  }, "Starting arb backtest");

  // Build DEX price lookup by date
  const dexByDate = new Map();
  for (const dp of dexPrices) {
    const key = dp.timestamp.toISOString().slice(0, 10);
    dexByDate.set(key, dp.price);
  }

  // Run signal engine on each data point and simulate trades
  const trades = [];
  const spreadHistory = []; // Rolling history for the arb signal module

  for (let i = 0; i < cexPrices.length; i++) {
    const cex = cexPrices[i];
    const dateKey = cex.timestamp.toISOString().slice(0, 10);
    const dexPrice = dexByDate.get(dateKey);

    if (!dexPrice) continue;

    // Run the arb signal with historical prices
    const signal = await arbAnalyze(pair, { cexPrice: cex.price, dexPrice }, spreadHistory);

    if (!signal || signal.direction === "neutral") continue;

    // Signal fired — simulate the trade
    const futurePrices = cexPrices.slice(i + 1);
    if (futurePrices.length === 0) continue;

    const trade = simulateTrade(
      {
        timestamp: cex.timestamp,
        price: cex.price,
        direction: signal.direction,
        signalType: "arbitrage",
        pair,
        confidence: signal.confidence,
      },
      futurePrices,
      params,
      arbFeeBps(positionSize)
    );

    if (trade) {
      trades.push(trade);
    }
  }

  const metrics = computeMetrics(trades);
  const graduation = checkGraduation(metrics, "arb");

  logger.info({
    module: "backtest",
    pair,
    signal: "arbitrage",
    trades: metrics.total_trades,
    hitRate: metrics.hit_rate,
    avgPnl: metrics.avg_pnl_bps,
    sharpe: metrics.sharpe_ratio,
    passes: graduation.passes,
  }, "Arb backtest complete");

  return { trades, metrics, graduation, pair, signalType: "arbitrage", params };
}

/**
 * Run directional signal backtest (trend + reversion + volatility).
 *
 * @param {string} pair
 * @param {Object} options - { startDate, endDate, params }
 */
export async function backtestDirectional(pair, options = {}) {
  const params = { ...DEFAULT_PARAMS.directional, ...options.params };
  const confidenceThreshold = options.confidenceThreshold ?? 0.5;

  // Load price history — prefer Coinbase (hourly), fall back to CoinGecko
  let prices = await loadPrices(pair, "coinbase", options.startDate, options.endDate);
  if (prices.length < 30) {
    prices = await loadPrices(pair, "coingecko", options.startDate, options.endDate);
  }

  if (prices.length < 30) {
    logger.warn({ module: "backtest", pair }, "Insufficient data for directional backtest (need 30+)");
    return { trades: [], metrics: computeMetrics([]), pair, signalType: "directional" };
  }

  logger.debug({
    module: "backtest",
    pair,
    points: prices.length,
    confidenceThreshold,
    params: `SL=${params.stopLossPct}% TP=${params.takeProfitPct}% TL=${params.timeLimitMs / 3600000}h`,
    dateRange: `${prices[0].timestamp.toISOString().slice(0, 10)} → ${prices[prices.length - 1].timestamp.toISOString().slice(0, 10)}`,
  }, "Starting directional backtest");

  const trades = [];
  const LOOKBACK = 50; // Need at least 50 prices for indicators

  for (let i = LOOKBACK; i < prices.length; i++) {
    // Build rolling price window for signal modules
    const priceWindow = prices.slice(Math.max(0, i - LOOKBACK), i + 1).map((p) => p.price);

    // Run all directional signals
    const signals = [];

    const trendSig = trendAnalyze(pair, priceWindow);
    if (trendSig) signals.push(trendSig);

    const revSig = reversionAnalyze(pair, priceWindow);
    if (revSig) signals.push(revSig);

    const volSig = volatilityAnalyze(pair, priceWindow);
    if (volSig) signals.push(volSig);

    if (signals.length === 0) continue;

    // Compute composite
    const composite = computeComposite(pair, signals);
    if (composite.direction === "neutral" || composite.composite_confidence < confidenceThreshold) continue;

    // Simulate trade
    const futurePrices = prices.slice(i + 1);
    if (futurePrices.length === 0) continue;

    const trade = simulateTrade(
      {
        timestamp: prices[i].timestamp,
        price: prices[i].price,
        direction: composite.direction,
        signalType: "directional",
        pair,
        confidence: composite.composite_confidence,
      },
      futurePrices,
      params,
      30 // ~30bps for a single DEX swap
    );

    if (trade) {
      trades.push(trade);

      // Skip ahead past the hold period to avoid overlapping trades
      const skipCandles = Math.max(1, Math.floor(trade.holdTimeMs / (3600 * 1000)));
      i += skipCandles;
    }
  }

  const metrics = computeMetrics(trades, { positionSizePct: options.positionSizePct });
  const graduation = checkGraduation(metrics, "directional");

  logger.debug({
    module: "backtest",
    pair,
    signal: "directional",
    trades: metrics.total_trades,
    hitRate: metrics.hit_rate,
    avgPnl: metrics.avg_pnl_bps,
    sharpe: metrics.sharpe_ratio,
    passes: graduation.passes,
  }, "Directional backtest complete");

  return { trades, metrics, graduation, pair, signalType: "directional", params };
}

/**
 * Save backtest results to Postgres.
 */
export async function saveResults(result) {
  if (!pool) return null;

  const runId = crypto.randomBytes(8).toString("hex");
  const trades = result.trades || [];
  const dateStart = trades.length > 0 ? trades[0].entryTimestamp : new Date();
  const dateEnd = trades.length > 0 ? trades[trades.length - 1].entryTimestamp : new Date();

  try {
    await pool.query(
      `INSERT INTO backtest_results
        (run_id, pair, signal_type, date_range_start, date_range_end,
         total_trades, winning_trades, losing_trades, hit_rate,
         avg_pnl_bps, total_pnl_bps, sharpe_ratio, max_drawdown_pct,
         profit_factor, params, trades)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        runId, result.pair, result.signalType, dateStart, dateEnd,
        result.metrics.total_trades, result.metrics.winning_trades,
        result.metrics.losing_trades, result.metrics.hit_rate,
        result.metrics.avg_pnl_bps, result.metrics.total_pnl_bps,
        result.metrics.sharpe_ratio, result.metrics.max_drawdown_pct,
        result.metrics.profit_factor, JSON.stringify(result.params),
        JSON.stringify(trades.slice(0, 100)), // Cap at 100 trades for storage
      ]
    );

    logger.info({ module: "backtest", runId, pair: result.pair }, "Results saved to Postgres");
    return runId;
  } catch (e) {
    logger.error({ module: "backtest", err: e.message }, "Failed to save results");
    return null;
  }
}
