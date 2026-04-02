// ============================================================
// CIRCUIT BREAKER FOR PAPER TRADING
// Implements safeguards against excessive losses and overexposure.
// ============================================================

import { pool } from "../db/schema.js";
import logger from "../logger.js";

// ── Configuration thresholds (easily tunable) ──
export const MAX_DRAWDOWN_BPS = -500; // -5% cumulative loss on last N trades
export const MAX_OPEN_POSITIONS = 3; // Maximum concurrent open trades
export const MAX_CONSECUTIVE_LOSSES = 3; // Consecutive losses before halt
export const LOSS_COOLDOWN_CYCLES = 2; // Cycles to wait after stop-loss
export const LOOKBACK_TRADES = 10; // Number of recent trades to inspect

/**
 * Check all circuit breaker conditions.
 *
 * @returns {Object} { allowed: boolean, reason: string|null, details: object }
 *   - allowed: true if trading is permitted
 *   - reason: null if allowed, otherwise human-readable reason
 *   - details: { open_positions: number, recent_pnl_bps: number, consecutive_losses: number, cooldown_pairs: string[] }
 */
export async function checkCircuitBreaker() {
  const details = {
    open_positions: 0,
    recent_pnl_bps: 0,
    consecutive_losses: 0,
    cooldown_pairs: [],
  };

  try {
    // ── Check 1: Max Concurrent Positions ──
    const { rows: openRows } = await pool.query(
      `SELECT COUNT(*) as count FROM paper_trades WHERE status = 'open'`
    );
    const openCount = parseInt(openRows[0].count, 10);
    details.open_positions = openCount;

    if (openCount >= MAX_OPEN_POSITIONS) {
      return {
        allowed: false,
        reason: `Max concurrent positions (${MAX_OPEN_POSITIONS}) reached. Currently open: ${openCount}`,
        details,
      };
    }

    // ── Check 2: Max Drawdown (Last N closed trades) ──
    const { rows: recentTrades } = await pool.query(
      `SELECT pnl_bps, pair, status FROM paper_trades
       WHERE status != 'open'
       ORDER BY exit_time DESC
       LIMIT $1`,
      [LOOKBACK_TRADES]
    );

    if (recentTrades.length > 0) {
      const recentPnl = recentTrades.reduce((sum, trade) => sum + parseFloat(trade.pnl_bps || 0), 0);
      details.recent_pnl_bps = Math.round(recentPnl * 100) / 100;

      if (recentPnl < MAX_DRAWDOWN_BPS) {
        return {
          allowed: false,
          reason: `Max drawdown exceeded on last ${recentTrades.length} trades. Cumulative P&L: ${details.recent_pnl_bps} bps (threshold: ${MAX_DRAWDOWN_BPS} bps)`,
          details,
        };
      }

      // ── Check 3: Consecutive Losses ──
      let consecutiveLosses = 0;
      for (const trade of recentTrades) {
        if (parseFloat(trade.pnl_bps || 0) < 0) {
          consecutiveLosses++;
        } else {
          break; // Stop counting at first win
        }
      }
      details.consecutive_losses = consecutiveLosses;

      if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
        return {
          allowed: false,
          reason: `Consecutive loss limit (${MAX_CONSECUTIVE_LOSSES}) reached. Last ${consecutiveLosses} trades were losses.`,
          details,
        };
      }
    }

    // ── Check 4: Cooldown After Stop-Loss Exit ──
    // Get all stop-loss trades from the last few cycles
    const { rows: stoppedOutTrades } = await pool.query(
      `SELECT DISTINCT pair, exit_time FROM paper_trades
       WHERE status = 'closed_sl'
       ORDER BY exit_time DESC
       LIMIT 20`
    );

    const now = new Date();
    const cooldownMs = LOSS_COOLDOWN_CYCLES * 60 * 1000; // Rough cycle duration estimate

    for (const trade of stoppedOutTrades) {
      const exitTime = new Date(trade.exit_time);
      const timeSinceSL = now.getTime() - exitTime.getTime();

      if (timeSinceSL < cooldownMs) {
        details.cooldown_pairs.push(trade.pair);
      }
    }

    if (details.cooldown_pairs.length > 0) {
      return {
        allowed: false,
        reason: `Cooldown period active after stop-loss exits. Restricted pairs: ${details.cooldown_pairs.join(", ")}`,
        details,
      };
    }

    // All checks passed
    return {
      allowed: true,
      reason: null,
      details,
    };
  } catch (err) {
    logger.error({ module: "circuit-breaker", err: err.message }, "Circuit breaker check failed");
    // Fail safe: deny trading on error
    return {
      allowed: false,
      reason: `Circuit breaker error: ${err.message}`,
      details,
    };
  }
}

/**
 * Check if a specific pair is on cooldown after stop-loss.
 * Useful for pair-specific gating before proposal creation.
 *
 * @param {string} pair
 * @returns {boolean} true if pair is on cooldown
 */
export async function isPairOnCooldown(pair) {
  try {
    const { rows } = await pool.query(
      `SELECT exit_time FROM paper_trades
       WHERE pair = $1 AND status = 'closed_sl'
       ORDER BY exit_time DESC
       LIMIT 1`,
      [pair]
    );

    if (rows.length === 0) {
      return false; // No stop-loss history
    }

    const exitTime = new Date(rows[0].exit_time);
    const now = new Date();
    const timeSinceSL = now.getTime() - exitTime.getTime();
    const cooldownMs = LOSS_COOLDOWN_CYCLES * 60 * 1000;

    return timeSinceSL < cooldownMs;
  } catch (err) {
    logger.error({ module: "circuit-breaker", pair, err: err.message }, "Cooldown check failed");
    return false; // Assume no cooldown on error
  }
}
