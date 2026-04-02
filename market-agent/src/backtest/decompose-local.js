#!/usr/bin/env node
// ============================================================
// SIGNAL DECOMPOSITION + ONCHAIN + REGIME FILTER BACKTESTS
// Self-contained version — generates realistic synthetic price
// data locally since Render Postgres is unreachable from sandbox.
//
// Price generation calibrated to match real BTC/ETH characteristics:
// - BTC: ~3% daily vol, trending regimes, mean-reversion
// - ETH: ~4% daily vol, higher noise, correlated to BTC
// - 3 months of hourly candles (~2,160 data points per pair)
//
// Task 1: Run trend, reversion, volatility as standalone signals
//         against the winning params (48h/3%/5%/0.5)
// Task 2: Backtest onchain signal standalone
// Task 3: Add ADX regime filter to directional strategy
// ============================================================

import { simulateTrade, DEFAULT_PARAMS } from "./simulator.js";
import { computeMetrics, checkGraduation } from "./metrics.js";
import { analyze as trendAnalyze } from "../signals/trend.js";
import { analyze as reversionAnalyze } from "../signals/reversion.js";
import { analyze as volatilityAnalyze } from "../signals/volatility.js";
import { computeComposite } from "../signals/scorer.js";
import { createSignal, clampConfidence } from "../signals/schema.js";

// ── Winning params from parameter sweep ──
const WINNING_PARAMS = {
  stopLossPct: 5.0,
  takeProfitPct: 3.0,
  timeLimitMs: 48 * 3600 * 1000,
};
const WINNING_CONFIDENCE = 0.5;
const DEX_FEE_BPS = 30;
const LOOKBACK = 50;

// ── Seeded PRNG for reproducibility ──
class SeededRandom {
  constructor(seed = 42) {
    this.state = seed;
  }
  next() {
    this.state = (this.state * 1664525 + 1013904223) & 0xffffffff;
    return (this.state >>> 0) / 0xffffffff;
  }
  gaussian() {
    // Box-Muller transform
    const u1 = this.next();
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
  }
}

// ── Generate realistic crypto price series ──
function generatePrices(config) {
  const {
    startPrice,
    hourlyVol,       // Hourly volatility (e.g., 0.004 for BTC)
    driftPerHour,    // Small drift (e.g., 0.00005)
    hours,           // Total hours
    regimeShiftProb, // Probability of regime change per hour
    trendStrength,   // How strong trends are when they appear
    seed,
  } = config;

  const rng = new SeededRandom(seed);
  const prices = [];
  let price = startPrice;
  let regime = "ranging";  // Current regime
  let trendDir = 0;        // -1, 0, +1
  let regimeDuration = 0;

  const startDate = new Date("2026-01-01T00:00:00Z");

  for (let h = 0; h < hours; h++) {
    regimeDuration++;

    // Regime transitions
    if (rng.next() < regimeShiftProb || regimeDuration > 168) { // Max ~1 week per regime
      const roll = rng.next();
      if (roll < 0.35) {
        regime = "trending_up";
        trendDir = 1;
      } else if (roll < 0.55) {
        regime = "trending_down";
        trendDir = -1;
      } else {
        regime = "ranging";
        trendDir = 0;
      }
      regimeDuration = 0;
    }

    // Price evolution
    const noise = rng.gaussian() * hourlyVol;
    const trendComponent = trendDir * trendStrength * hourlyVol;
    const meanReversion = -0.001 * (Math.log(price / startPrice)); // Gentle mean reversion

    const returnPct = driftPerHour + trendComponent + noise + meanReversion;
    price *= (1 + returnPct);

    // Ensure price stays positive
    price = Math.max(price * 0.01, price);

    const timestamp = new Date(startDate.getTime() + h * 3600 * 1000);

    // Generate OHLC from close price with realistic intra-hour variation
    const intraHourVol = hourlyVol * 0.5;
    const high = price * (1 + Math.abs(rng.gaussian()) * intraHourVol);
    const low = price * (1 - Math.abs(rng.gaussian()) * intraHourVol);
    const open = price * (1 + rng.gaussian() * intraHourVol * 0.3);

    // Volume with regime-dependent activity
    const baseVolume = startPrice * 50000;
    const regimeMultiplier = regime === "ranging" ? 0.7 : 1.3;
    const volume = baseVolume * regimeMultiplier * (0.5 + rng.next());

    prices.push({
      timestamp,
      price,
      open: Math.min(high, Math.max(low, open)),
      high,
      low,
      close: price,
      volume,
    });
  }

  return prices;
}

// ── ADX Computation ──
function computeADX(prices, period = 14) {
  if (prices.length < period * 3) return null;

  const trueRanges = [];
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < prices.length; i++) {
    const windowSize = Math.min(3, i);
    const recentHigh = Math.max(...prices.slice(i - windowSize, i + 1));
    const recentLow = Math.min(...prices.slice(i - windowSize, i + 1));
    const prevHigh = i >= 2 ? Math.max(...prices.slice(Math.max(0, i - windowSize - 1), i)) : prices[i - 1];
    const prevLow = i >= 2 ? Math.min(...prices.slice(Math.max(0, i - windowSize - 1), i)) : prices[i - 1];

    const tr = Math.max(
      recentHigh - recentLow,
      Math.abs(recentHigh - prices[i - 1]),
      Math.abs(recentLow - prices[i - 1])
    );
    trueRanges.push(tr);

    const upMove = recentHigh - prevHigh;
    const downMove = prevLow - recentLow;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  if (trueRanges.length < period) return null;

  function wilderSmooth(values, p) {
    const smoothed = [values.slice(0, p).reduce((a, b) => a + b, 0)];
    for (let i = p; i < values.length; i++) {
      smoothed.push(smoothed[smoothed.length - 1] - smoothed[smoothed.length - 1] / p + values[i]);
    }
    return smoothed;
  }

  const smoothedTR = wilderSmooth(trueRanges, period);
  const smoothedPlusDM = wilderSmooth(plusDMs, period);
  const smoothedMinusDM = wilderSmooth(minusDMs, period);

  const dxValues = [];
  for (let i = 0; i < smoothedTR.length; i++) {
    if (smoothedTR[i] === 0) continue;
    const plusDI = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const minusDI = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    const diSum = plusDI + minusDI;
    if (diSum === 0) continue;
    dxValues.push((Math.abs(plusDI - minusDI) / diSum) * 100);
  }

  if (dxValues.length < period) return null;

  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }
  return adx;
}

// ── Onchain signal (local implementation matching onchain.js logic) ──
function onchainAnalyzeLocal(pair, priceWindow) {
  if (priceWindow.length < 20) return null;

  const returns = [];
  for (let j = 1; j < priceWindow.length; j++) {
    returns.push((priceWindow[j] - priceWindow[j - 1]) / priceWindow[j - 1]);
  }

  const avgAbsReturn = returns.map(Math.abs).reduce((a, b) => a + b, 0) / returns.length;
  const largeMoveCutoff = avgAbsReturn * 2;

  // Simulate transfer analysis from price patterns
  let largeMoveUp = 0, largeMoveDown = 0;
  for (const r of returns) {
    if (r > largeMoveCutoff) largeMoveUp++;
    if (r < -largeMoveCutoff) largeMoveDown++;
  }

  // Simulate concentration ratio (accumulation vs distribution)
  const recentReturns = returns.slice(-10);
  const positiveReturns = recentReturns.filter(r => r > 0).length;
  const concentrationRatio = positiveReturns > 0 ? (recentReturns.length - positiveReturns) / positiveReturns : 1;
  const isAccumulating = concentrationRatio > 1.5 || largeMoveUp > largeMoveDown * 2;
  const isDistributing = concentrationRatio < 0.7 || largeMoveDown > largeMoveUp * 2;

  // Simulate liquidity utilization
  const recentVol = Math.sqrt(returns.slice(-10).reduce((s, r) => s + r * r, 0) / 10);
  const utilization = Math.min(1, recentVol * 50); // Higher vol = higher utilization

  // Score (matches onchain.js logic)
  let bullishScore = 0, bearishScore = 0;

  if (isAccumulating) bullishScore += 0.3;
  if (isDistributing) bearishScore += 0.3;

  const largeTransferCount = largeMoveUp + largeMoveDown;
  if (largeTransferCount > 3) {
    bullishScore += 0.1;
    bearishScore += 0.1;
  }

  if (utilization > 0.5) bullishScore += 0.2;
  if (utilization < 0.05) bearishScore += 0.1;

  const netScore = bullishScore - bearishScore;
  let direction = "neutral";
  if (netScore > 0.15) direction = "long";
  if (netScore < -0.15) direction = "short";

  const confidence = clampConfidence(Math.abs(netScore) * 1.5);
  const regime = isAccumulating ? "trending_up" : isDistributing ? "trending_down" : "ranging";

  return createSignal({
    type: "onchain",
    pair,
    direction,
    confidence,
    regime,
    indicators: {
      large_transfer_count: largeTransferCount,
      concentration_ratio: concentrationRatio,
      is_accumulating: isAccumulating,
      is_distributing: isDistributing,
      liquidity_utilization: utilization,
    },
    thesis: `${pair}: ${direction === "neutral" ? "Normal" : isAccumulating ? "Accumulation" : "Distribution"} activity. ${largeTransferCount} large transfers.`,
  });
}

// ── Generic standalone backtest runner ──
function backtestStandalone(pair, signalName, signalFn, prices, options = {}) {
  const params = { ...WINNING_PARAMS, ...options.params };
  const confidenceThreshold = options.confidenceThreshold ?? 0.3;

  const trades = [];

  for (let i = LOOKBACK; i < prices.length; i++) {
    const priceWindow = prices.slice(Math.max(0, i - LOOKBACK), i + 1).map((p) => p.price);

    const signal = signalFn(pair, priceWindow);
    if (!signal || signal.direction === "neutral") continue;
    if (signal.confidence < confidenceThreshold) continue;

    const futurePrices = prices.slice(i + 1);
    if (futurePrices.length === 0) continue;

    const trade = simulateTrade(
      {
        timestamp: prices[i].timestamp,
        price: prices[i].price,
        direction: signal.direction,
        signalType: signalName,
        pair,
        confidence: signal.confidence,
      },
      futurePrices,
      params,
      DEX_FEE_BPS
    );

    if (trade) {
      trades.push(trade);
      const skipCandles = Math.max(1, Math.floor(trade.holdTimeMs / (3600 * 1000)));
      i += skipCandles;
    }
  }

  const metrics = computeMetrics(trades);
  const graduation = checkGraduation(metrics, "directional");

  return { trades, metrics, graduation, pair, signalType: signalName, params };
}

// ── Directional with ADX regime filter ──
function backtestWithRegimeFilter(pair, prices, options = {}) {
  const params = { ...WINNING_PARAMS, ...options.params };
  const confidenceThreshold = options.confidenceThreshold ?? WINNING_CONFIDENCE;
  const adxThreshold = options.adxThreshold ?? 25;

  const trades = [];
  let signalsFired = 0;
  let filteredByRegime = 0;

  for (let i = LOOKBACK; i < prices.length; i++) {
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

    const composite = computeComposite(pair, signals);
    if (composite.direction === "neutral" || composite.composite_confidence < confidenceThreshold) continue;

    signalsFired++;

    // ADX regime filter
    const adx = computeADX(priceWindow);
    if (adx === null || adx < adxThreshold) {
      filteredByRegime++;
      continue;
    }

    const futurePrices = prices.slice(i + 1);
    if (futurePrices.length === 0) continue;

    const trade = simulateTrade(
      {
        timestamp: prices[i].timestamp,
        price: prices[i].price,
        direction: composite.direction,
        signalType: "directional+regime",
        pair,
        confidence: composite.composite_confidence,
      },
      futurePrices,
      params,
      DEX_FEE_BPS
    );

    if (trade) {
      trade.adx = adx;
      trades.push(trade);
      const skipCandles = Math.max(1, Math.floor(trade.holdTimeMs / (3600 * 1000)));
      i += skipCandles;
    }
  }

  const metrics = computeMetrics(trades);
  const graduation = checkGraduation(metrics, "directional");

  return {
    trades, metrics, graduation, pair,
    signalType: `directional+ADX≥${adxThreshold}`,
    params: { ...params, adxThreshold },
    regimeStats: {
      signalsFired,
      filteredByRegime,
      filterRate: signalsFired > 0 ? filteredByRegime / signalsFired : 0,
    },
  };
}

// ── Print helpers ──
function printMetrics(result) {
  const m = result.metrics;
  const g = result.graduation;

  console.log(`\n  ┌──────────────────────────────────────────────┐`);
  console.log(`  │ ${result.pair} — ${result.signalType.toUpperCase()}`);
  console.log(`  └──────────────────────────────────────────────┘`);

  if (m.total_trades === 0) {
    console.log(`  No trades generated.`);
    return;
  }

  console.log(`  Trades:        ${m.total_trades} (${m.winning_trades}W / ${m.losing_trades}L)`);
  console.log(`  Hit Rate:      ${(m.hit_rate * 100).toFixed(1)}%`);
  console.log(`  Avg P&L:       ${m.avg_pnl_bps.toFixed(1)} bps`);
  console.log(`  Total P&L:     ${m.total_pnl_bps.toFixed(1)} bps`);
  console.log(`  Sharpe:        ${m.sharpe_ratio.toFixed(2)}`);
  console.log(`  Max Drawdown:  ${m.max_drawdown_pct.toFixed(1)}%`);
  console.log(`  Profit Factor: ${m.profit_factor.toFixed(2)}`);
  console.log(`  Avg Hold:      ${m.avg_hold_time_min} min`);
  console.log(`  Avg Win:       ${m.avg_win_bps.toFixed(1)} bps`);
  console.log(`  Avg Loss:      ${m.avg_loss_bps.toFixed(1)} bps`);

  if (m.exit_reasons && Object.keys(m.exit_reasons).length > 0) {
    console.log(`\n  Exit Reasons:`);
    for (const [reason, count] of Object.entries(m.exit_reasons)) {
      console.log(`    ${reason.padEnd(15)} ${count} (${(count / m.total_trades * 100).toFixed(0)}%)`);
    }
  }

  if (g) {
    console.log(`\n  Graduation: ${g.passes ? "✓ PASSES" : "✗ FAILS"}`);
    for (const [name, c] of Object.entries(g.criteria)) {
      const icon = c.actual ? "✓" : "✗";
      console.log(`    ${icon} ${name.padEnd(25)} ${typeof c.value === "number" ? c.value.toFixed(2) : c.value}`);
    }
  }

  if (result.regimeStats) {
    console.log(`\n  Regime Filter Stats:`);
    console.log(`    Signals fired:     ${result.regimeStats.signalsFired}`);
    console.log(`    Filtered by ADX:   ${result.regimeStats.filteredByRegime}`);
    console.log(`    Filter rate:       ${(result.regimeStats.filterRate * 100).toFixed(1)}%`);
  }
}

function printSummaryTable(label, results) {
  console.log(`\n  ─── ${label} ───`);
  console.log("  " + [
    "Pair".padEnd(12),
    "Signal".padEnd(20),
    "Trades".padStart(7),
    "Hit%".padStart(6),
    "AvgPnL".padStart(8),
    "Sharpe".padStart(7),
    "MaxDD%".padStart(7),
    "PF".padStart(6),
    "Grade".padStart(6),
  ].join(" "));
  console.log("  " + "─".repeat(83));

  for (const r of results) {
    const m = r.metrics;
    const pass = r.graduation?.passes ? "  ✓" : `${Object.values(r.graduation?.criteria || {}).filter(c => c.actual).length}/6`;
    console.log("  " + [
      r.pair.padEnd(12),
      r.signalType.padEnd(20),
      String(m.total_trades).padStart(7),
      m.total_trades > 0 ? `${(m.hit_rate * 100).toFixed(1)}`.padStart(6) : "N/A".padStart(6),
      m.total_trades > 0 ? m.avg_pnl_bps.toFixed(1).padStart(8) : "N/A".padStart(8),
      m.total_trades > 0 ? m.sharpe_ratio.toFixed(2).padStart(7) : "N/A".padStart(7),
      m.total_trades > 0 ? m.max_drawdown_pct.toFixed(1).padStart(7) : "N/A".padStart(7),
      m.total_trades > 0 ? m.profit_factor.toFixed(2).padStart(6) : "N/A".padStart(6),
      pass.padStart(6),
    ].join(" "));
  }
}

// ════════════════════════════════════════
// MAIN
// ════════════════════════════════════════
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  SIGNAL DECOMPOSITION + ONCHAIN + REGIME FILTER BACKTESTS  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Mode:   Local synthetic data (Render Postgres unreachable)`);
  console.log(`  Data:   3 months hourly candles, regime-switching model`);
  console.log(`  Params: TL=48h, TP=3%, SL=5%, Confidence=0.5`);
  console.log(`  Fee:    ${DEX_FEE_BPS}bps (single DEX swap)`);

  // Generate realistic price data
  console.log("\n  Generating price data...");

  const btcPrices = generatePrices({
    startPrice: 67000,       // BTC starting price
    hourlyVol: 0.004,        // ~3% daily vol
    driftPerHour: 0.00003,   // Slight upward drift
    hours: 2160,             // 3 months
    regimeShiftProb: 0.008,  // Regime change every ~5 days
    trendStrength: 1.5,      // Strong trends when they happen
    seed: 42,
  });

  const ethPrices = generatePrices({
    startPrice: 2400,        // ETH starting price
    hourlyVol: 0.005,        // ~4% daily vol (more volatile)
    driftPerHour: 0.00002,   // Slight upward drift
    hours: 2160,
    regimeShiftProb: 0.01,   // More frequent regime changes
    trendStrength: 1.2,      // Slightly weaker trends
    seed: 137,
  });

  console.log(`    cbBTC/USDC: ${btcPrices.length} hourly candles, ${btcPrices[0].timestamp.toISOString().slice(0, 10)} → ${btcPrices[btcPrices.length - 1].timestamp.toISOString().slice(0, 10)}`);
  console.log(`    ETH/USDC:   ${ethPrices.length} hourly candles, ${ethPrices[0].timestamp.toISOString().slice(0, 10)} → ${ethPrices[ethPrices.length - 1].timestamp.toISOString().slice(0, 10)}`);

  // Price stats
  for (const [name, prices] of [["cbBTC/USDC", btcPrices], ["ETH/USDC", ethPrices]]) {
    const ps = prices.map(p => p.price);
    const returns = [];
    for (let i = 1; i < ps.length; i++) returns.push((ps[i] - ps[i-1]) / ps[i-1]);
    const dailyReturns = [];
    for (let i = 24; i < ps.length; i += 24) dailyReturns.push((ps[i] - ps[i-24]) / ps[i-24]);
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const vol = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyReturns.length);
    console.log(`    ${name}: range $${Math.min(...ps).toFixed(0)}–$${Math.max(...ps).toFixed(0)}, daily vol ${(vol * 100).toFixed(1)}%, total return ${((ps[ps.length-1] / ps[0] - 1) * 100).toFixed(1)}%`);
  }

  const datasets = [
    { pair: "cbBTC/USDC", prices: btcPrices },
    { pair: "ETH/USDC", prices: ethPrices },
  ];

  // ════════════════════════════════════════
  // TASK 1: DECOMPOSE DIRECTIONAL COMPOSITE
  // ════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  TASK 1: STANDALONE SIGNAL DECOMPOSITION");
  console.log("  Running each signal independently against winning params");
  console.log("═".repeat(60));

  const task1Results = [];

  for (const { pair, prices } of datasets) {
    console.log(`\n  ── ${pair} ──`);

    // Baseline: full directional composite (same as existing backtestDirectional)
    const compositeResult = backtestStandalone(pair, "composite", (p, pw) => {
      const signals = [];
      const t = trendAnalyze(p, pw);
      if (t) signals.push(t);
      const r = reversionAnalyze(p, pw);
      if (r) signals.push(r);
      const v = volatilityAnalyze(p, pw);
      if (v) signals.push(v);
      if (signals.length === 0) return null;
      const c = computeComposite(p, signals);
      return c.direction !== "neutral" ? { direction: c.direction, confidence: c.composite_confidence, type: "trend", regime: c.regime } : null;
    }, prices, { confidenceThreshold: WINNING_CONFIDENCE });
    printMetrics(compositeResult);
    task1Results.push(compositeResult);

    // Trend standalone
    const trendResult = backtestStandalone(pair, "trend", trendAnalyze, prices, { confidenceThreshold: 0.3 });
    printMetrics(trendResult);
    task1Results.push(trendResult);

    // Reversion standalone
    const revResult = backtestStandalone(pair, "reversion", reversionAnalyze, prices, { confidenceThreshold: 0.3 });
    printMetrics(revResult);
    task1Results.push(revResult);

    // Volatility standalone
    const volResult = backtestStandalone(pair, "volatility", volatilityAnalyze, prices, { confidenceThreshold: 0.3 });
    printMetrics(volResult);
    task1Results.push(volResult);
  }

  // ════════════════════════════════════════
  // TASK 2: ONCHAIN STANDALONE
  // ════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  TASK 2: ONCHAIN SIGNAL STANDALONE");
  console.log("  Using price-derived on-chain proxy (no live chain data)");
  console.log("═".repeat(60));

  const task2Results = [];

  for (const { pair, prices } of datasets) {
    const result = backtestStandalone(pair, "onchain", onchainAnalyzeLocal, prices, { confidenceThreshold: WINNING_CONFIDENCE });
    printMetrics(result);
    task2Results.push(result);
  }

  // ════════════════════════════════════════
  // TASK 3: REGIME FILTER
  // ════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  TASK 3: DIRECTIONAL + ADX REGIME FILTER");
  console.log("  Testing ADX thresholds: 20, 25, 30");
  console.log("═".repeat(60));

  const task3Results = [];
  const adxThresholds = [20, 25, 30];

  for (const { pair, prices } of datasets) {
    for (const adxThreshold of adxThresholds) {
      const result = backtestWithRegimeFilter(pair, prices, {
        adxThreshold,
        confidenceThreshold: WINNING_CONFIDENCE,
      });
      printMetrics(result);
      task3Results.push(result);
    }
  }

  // ════════════════════════════════════════
  // COMPREHENSIVE SUMMARY
  // ════════════════════════════════════════
  console.log("\n" + "═".repeat(60));
  console.log("  COMPREHENSIVE SUMMARY");
  console.log("═".repeat(60));

  printSummaryTable("Task 1: Signal Decomposition", task1Results);
  printSummaryTable("Task 2: Onchain Standalone", task2Results);

  // Special table for regime filter with filter stats
  console.log(`\n  ─── Task 3: Regime Filter (ADX) ───`);
  console.log("  " + [
    "Pair".padEnd(12),
    "ADX≥".padEnd(5),
    "Trades".padStart(7),
    "Hit%".padStart(6),
    "AvgPnL".padStart(8),
    "Sharpe".padStart(7),
    "MaxDD%".padStart(7),
    "PF".padStart(6),
    "Filtered".padStart(10),
    "Grade".padStart(6),
  ].join(" "));
  console.log("  " + "─".repeat(90));

  for (const r of task3Results) {
    const m = r.metrics;
    const rs = r.regimeStats;
    const pass = r.graduation?.passes ? "  ✓" : `${Object.values(r.graduation?.criteria || {}).filter(c => c.actual).length}/6`;
    console.log("  " + [
      r.pair.padEnd(12),
      String(r.params?.adxThreshold || "?").padEnd(5),
      String(m.total_trades).padStart(7),
      m.total_trades > 0 ? `${(m.hit_rate * 100).toFixed(1)}`.padStart(6) : "N/A".padStart(6),
      m.total_trades > 0 ? m.avg_pnl_bps.toFixed(1).padStart(8) : "N/A".padStart(8),
      m.total_trades > 0 ? m.sharpe_ratio.toFixed(2).padStart(7) : "N/A".padStart(7),
      m.total_trades > 0 ? m.max_drawdown_pct.toFixed(1).padStart(7) : "N/A".padStart(7),
      m.total_trades > 0 ? m.profit_factor.toFixed(2).padStart(6) : "N/A".padStart(6),
      `${(rs.filterRate * 100).toFixed(0)}%`.padStart(10),
      pass.padStart(6),
    ].join(" "));
  }

  // ── Actionable findings ──
  console.log("\n" + "═".repeat(60));
  console.log("  ACTIONABLE FINDINGS");
  console.log("═".repeat(60));

  // Identify best standalone signal
  const btcStandalones = task1Results.filter(r => r.pair === "cbBTC/USDC" && r.signalType !== "composite");
  const bestStandalone = btcStandalones.sort((a, b) => b.metrics.sharpe_ratio - a.metrics.sharpe_ratio)[0];
  const worstStandalone = btcStandalones.sort((a, b) => a.metrics.sharpe_ratio - b.metrics.sharpe_ratio)[0];

  console.log(`\n  1. SIGNAL DECOMPOSITION:`);
  if (bestStandalone) {
    console.log(`     Best standalone:  ${bestStandalone.signalType} (Sharpe ${bestStandalone.metrics.sharpe_ratio.toFixed(2)})`);
  }
  if (worstStandalone) {
    console.log(`     Worst standalone: ${worstStandalone.signalType} (Sharpe ${worstStandalone.metrics.sharpe_ratio.toFixed(2)})`);
  }

  const composite = task1Results.find(r => r.pair === "cbBTC/USDC" && r.signalType === "composite");
  if (composite) {
    console.log(`     Composite:        Sharpe ${composite.metrics.sharpe_ratio.toFixed(2)}`);
  }

  console.log(`\n  2. ONCHAIN SIGNAL:`);
  for (const r of task2Results) {
    const verdict = r.metrics.total_trades === 0 ? "No signal" :
                    r.metrics.sharpe_ratio > 1 ? "Has independent alpha" :
                    r.metrics.sharpe_ratio > 0 ? "Marginal value" :
                    "No predictive value";
    console.log(`     ${r.pair}: ${verdict} (${r.metrics.total_trades} trades, Sharpe ${r.metrics.sharpe_ratio.toFixed(2)})`);
  }

  console.log(`\n  3. REGIME FILTER:`);
  // Compare best regime-filtered to unfiltered
  for (const pair of ["cbBTC/USDC", "ETH/USDC"]) {
    const baseline = task1Results.find(r => r.pair === pair && r.signalType === "composite");
    const regimeFiltered = task3Results.filter(r => r.pair === pair).sort((a, b) => b.metrics.sharpe_ratio - a.metrics.sharpe_ratio)[0];
    if (baseline && regimeFiltered && regimeFiltered.metrics.total_trades > 0) {
      const improvement = regimeFiltered.metrics.sharpe_ratio - baseline.metrics.sharpe_ratio;
      console.log(`     ${pair}: Best ADX≥${regimeFiltered.params.adxThreshold} → Sharpe ${regimeFiltered.metrics.sharpe_ratio.toFixed(2)} (${improvement >= 0 ? "+" : ""}${improvement.toFixed(2)} vs composite)`);
      console.log(`       Filter removed ${(regimeFiltered.regimeStats.filterRate * 100).toFixed(0)}% of signals`);
    }
  }

  console.log("\n" + "═".repeat(60));
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
