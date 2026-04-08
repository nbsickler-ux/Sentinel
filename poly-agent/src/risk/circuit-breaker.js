// ============================================================
// CIRCUIT BREAKER FOR POLYMARKET TRADING
// Adapted from Market Agent's circuit breaker with prediction
// market-specific parameters.
// ============================================================

import { pool } from "../db/schema.js";
import config from "../config.js";
import logger from "../logger.js";

const {
  maxConcurrentPositions,
  maxDailyLossPct,
  maxDrawdownPct,
  maxConsecutiveLosses,
  positionReductionOnStreak,
} = config.risk;

/**
 * Check all circuit breaker conditions.
 * Returns whether trading is allowed and any size adjustments.
 */
export async function checkCircuitBreaker() {
  const details = {
    open_positions: 0,
    daily_pnl_pct: 0,
    peak_bankroll: 0,
    current_bankroll: 0,
    drawdown_pct: 0,
    consecutive_losses: 0,
    size_multiplier: 1.0, // Reduced on loss streaks
  };

  try {
    // ── Check 1: Max concurrent positions ──
    const { rows: openRows } = await pool.query(
      `SELECT COUNT(*) as count FROM poly_positions WHERE status = 'open'`
    );
    details.open_positions = parseInt(openRows[0].count, 10);

    if (details.open_positions >= maxConcurrentPositions) {
      return {
        allowed: false,
        reason: `Max positions (${maxConcurrentPositions}) reached. Open: ${details.open_positions}`,
        details,
      };
    }

    // ── Check 2: Daily loss limit ──
    const { rows: dailyRows } = await pool.query(
      `SELECT COALESCE(SUM(pnl_usd), 0) as daily_pnl
       FROM poly_positions
       WHERE status != 'open'
       AND closed_at >= CURRENT_DATE`
    );
    const dailyPnl = parseFloat(dailyRows[0].daily_pnl);

    // Get current bankroll for percentage calculation
    const { rows: bankrollRows } = await pool.query(
      `SELECT COALESCE(
        (SELECT balance FROM poly_bankroll ORDER BY updated_at DESC LIMIT 1),
        0
      ) as balance`
    );
    const bankroll = parseFloat(bankrollRows[0].balance) || 1000; // Default $1000
    details.current_bankroll = bankroll;
    details.daily_pnl_pct = bankroll > 0 ? dailyPnl / bankroll : 0;

    if (details.daily_pnl_pct < -maxDailyLossPct) {
      return {
        allowed: false,
        reason: `Daily loss limit exceeded: ${(details.daily_pnl_pct * 100).toFixed(2)}% (max: -${(maxDailyLossPct * 100).toFixed(0)}%)`,
        details,
      };
    }

    // ── Check 3: Max drawdown from peak ──
    const { rows: peakRows } = await pool.query(
      `SELECT COALESCE(MAX(balance), 0) as peak
       FROM poly_bankroll`
    );
    details.peak_bankroll = parseFloat(peakRows[0].peak) || bankroll;
    details.drawdown_pct = details.peak_bankroll > 0
      ? (bankroll - details.peak_bankroll) / details.peak_bankroll
      : 0;

    if (details.drawdown_pct < -maxDrawdownPct) {
      return {
        allowed: false,
        reason: `Max drawdown exceeded: ${(details.drawdown_pct * 100).toFixed(2)}% from peak (max: -${(maxDrawdownPct * 100).toFixed(0)}%)`,
        details,
      };
    }

    // ── Check 4: Consecutive losses ──
    const { rows: recentTrades } = await pool.query(
      `SELECT pnl_usd FROM poly_positions
       WHERE status != 'open'
       ORDER BY closed_at DESC
       LIMIT 20`
    );

    let consecutiveLosses = 0;
    for (const trade of recentTrades) {
      if (parseFloat(trade.pnl_usd) < 0) {
        consecutiveLosses++;
      } else {
        break;
      }
    }
    details.consecutive_losses = consecutiveLosses;

    if (consecutiveLosses >= maxConsecutiveLosses) {
      // Don't halt entirely — reduce size by 50%
      details.size_multiplier = positionReductionOnStreak;
      logger.warn({
        module: "circuit-breaker",
        consecutiveLosses,
      }, `Loss streak: reducing position sizes to ${positionReductionOnStreak * 100}%`);
    }

    return {
      allowed: true,
      reason: null,
      details,
    };
  } catch (err) {
    logger.error({ module: "circuit-breaker", err: err.message }, "Circuit breaker check failed");
    // Fail safe: deny trading
    return {
      allowed: false,
      reason: `Circuit breaker error: ${err.message}`,
      details,
    };
  }
}
