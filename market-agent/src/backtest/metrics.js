// ============================================================
// PERFORMANCE METRICS
// Computes backtest statistics per signal type and overall.
// ============================================================

/**
 * Compute comprehensive performance metrics from trade results.
 *
 * @param {Object[]} trades - Array of trade results from simulator
 * @returns {Object} Performance metrics
 */
export function computeMetrics(trades, options = {}) {
  const positionSizePct = options.positionSizePct || 100;

  if (!trades || trades.length === 0) {
    return {
      total_trades: 0,
      winning_trades: 0,
      losing_trades: 0,
      hit_rate: 0,
      avg_pnl_bps: 0,
      total_pnl_bps: 0,
      sharpe_ratio: 0,
      max_drawdown_pct: 0,
      profit_factor: 0,
      avg_hold_time_min: 0,
      exit_reasons: {},
    };
  }

  const wins = trades.filter((t) => t.isWin);
  const losses = trades.filter((t) => !t.isWin);
  const pnls = trades.map((t) => t.netPnlBps);

  // Basic stats
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const avgPnl = totalPnl / trades.length;
  const hitRate = wins.length / trades.length;

  // Sharpe ratio (annualized) — always based on per-trade bps (signal quality metric)
  const mean = avgPnl;
  const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (pnls.length - 1 || 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

  // Max drawdown — measured against portfolio base for realistic position-sized drawdown
  // At positionSizePct=100 (default), each trade's full bps hit applies to portfolio.
  // At positionSizePct=0.5, a -500bps trade only moves portfolio by -2.5bps.
  const portfolioBase = 10000; // 10000 bps = 100% of portfolio
  let portfolio = portfolioBase;
  let peak = portfolioBase;
  let maxDrawdown = 0;
  for (const pnl of pnls) {
    const scaledPnl = pnl * (positionSizePct / 100);
    portfolio += scaledPnl;
    if (portfolio > peak) peak = portfolio;
    const drawdown = peak - portfolio;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  const maxDrawdownPct = peak > 0 ? (maxDrawdown / peak) * 100 : 0;

  // Profit factor: gross gains / gross losses
  const grossGains = wins.reduce((sum, t) => sum + t.netPnlBps, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnlBps, 0));
  const profitFactor = grossLosses > 0 ? grossGains / grossLosses : grossGains > 0 ? Infinity : 0;

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  // Average hold time
  const avgHoldTime = trades.reduce((sum, t) => sum + t.holdTimeMin, 0) / trades.length;

  // Average win/loss size
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnlBps, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPnlBps, 0) / losses.length : 0;

  return {
    total_trades: trades.length,
    winning_trades: wins.length,
    losing_trades: losses.length,
    hit_rate: Math.round(hitRate * 1000) / 1000,
    avg_pnl_bps: Math.round(avgPnl * 100) / 100,
    total_pnl_bps: Math.round(totalPnl * 100) / 100,
    sharpe_ratio: Math.round(sharpe * 100) / 100,
    max_drawdown_pct: Math.round(maxDrawdownPct * 100) / 100,
    profit_factor: Math.round(profitFactor * 100) / 100,
    avg_hold_time_min: Math.round(avgHoldTime),
    avg_win_bps: Math.round(avgWin * 100) / 100,
    avg_loss_bps: Math.round(avgLoss * 100) / 100,
    exit_reasons: exitReasons,
  };
}

/**
 * Check if metrics meet the signal graduation criteria from the brief.
 *
 * @param {Object} metrics - Output of computeMetrics
 * @param {string} signalType - "arb" or "directional"
 * @returns {Object} { passes, criteria }
 */
export function checkGraduation(metrics, signalType) {
  const minHitRate = signalType === "arb" ? 0.55 : 0.40;
  const minTrades = 30;

  const criteria = {
    positive_ev: { required: true, actual: metrics.avg_pnl_bps > 0, value: metrics.avg_pnl_bps },
    sharpe_above_1: { required: true, actual: metrics.sharpe_ratio > 1.0, value: metrics.sharpe_ratio },
    max_dd_below_15: { required: true, actual: metrics.max_drawdown_pct < 15, value: metrics.max_drawdown_pct },
    hit_rate: { required: minHitRate, actual: metrics.hit_rate >= minHitRate, value: metrics.hit_rate },
    profit_factor_above_1_5: { required: true, actual: metrics.profit_factor > 1.5, value: metrics.profit_factor },
    min_trades: { required: minTrades, actual: metrics.total_trades >= minTrades, value: metrics.total_trades },
  };

  const passes = Object.values(criteria).every((c) => c.actual);

  return { passes, criteria };
}
