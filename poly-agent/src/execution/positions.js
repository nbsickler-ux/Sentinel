// ============================================================
// POSITION LIFECYCLE MANAGER
// Active management of open positions: profit-taking, stop-loss,
// edge compression exits, and hold-through-resolution decisions.
//
// KEY INSIGHT: Our edge is INFORMATION SPEED, not game prediction.
// Once the market catches up to our estimate, the edge is gone.
// Take profit and redeploy capital — don't gamble on outcomes.
// ============================================================

import { pool } from "../db/schema.js";
import config from "../config.js";
import logger from "../logger.js";
// Weather bot holds to settlement — position exits are minimal
// Old polymarket/bookmaker exit logic removed

/**
 * Evaluate exit conditions for all open positions.
 * Delegates to edge.js for bookmaker-referenced exit logic.
 *
 * @param {Map} latestOdds - condition_id → { yes, no, timestamp }
 * @param {Array} bookmakerEvents - Latest bookmaker events for fair value comparison
 */
/**
 * Evaluate exits — weather bot default is hold to settlement.
 * Only exits on hard stop or forecast flip (handled by agent.js).
 */
export async function evaluateExits() {
  // Weather strategy holds to settlement by default
  // Early exits only triggered by agent when forecast materially flips
  return [];
}

/**
 * Execute a position exit via Kalshi API.
 */
async function executeExit(position, exitDecision, currentPrice) {
  try {
    await updatePositionClosed(position, exitDecision, currentPrice);
    logger.info({
      module: "positions",
      market: position.market_question?.slice(0, 50),
      type: exitDecision.type,
      pnl: `${exitDecision.priceDelta >= 0 ? "+" : ""}${exitDecision.priceDelta.toFixed(1)}¢`,
    }, "Position exited");
  } catch (err) {
    logger.error({ module: "positions", err: err.message, positionId: position.id }, "Exit execution failed");
  }
}

/**
 * Record a paper exit (analysis mode).
 */
async function recordPaperExit(position, exitDecision, currentPrice) {
  await updatePositionClosed(position, exitDecision, currentPrice);
  logger.info({
    module: "positions",
    mode: "analysis",
    market: position.market_question?.slice(0, 50),
    type: exitDecision.type,
    pnl: `${exitDecision.priceDelta >= 0 ? "+" : ""}${exitDecision.priceDelta.toFixed(1)}¢`,
  }, "Position exited (paper)");
}

/**
 * Update a position as closed in the database.
 */
async function updatePositionClosed(position, exitDecision, exitPrice) {
  if (!pool) return;

  const entryPrice = parseFloat(position.entry_price);
  const sizeUsd = parseFloat(position.size_usd);

  // P&L calculation for early exit:
  // Bought at entryPrice, selling at exitPrice
  // Shares owned = sizeUsd / entryPrice
  // Sale proceeds = shares * exitPrice
  // P&L = proceeds - cost = shares * (exitPrice - entryPrice)
  const shares = sizeUsd / entryPrice;
  const pnlUsd = shares * (exitPrice - entryPrice);
  const pnlPct = (exitPrice - entryPrice) / entryPrice;

  // Map exit type to status
  const statusMap = {
    hard_stop: "closed_sl",
    bookmaker_stop_negative: "closed_bm_stop",
    bookmaker_stop_compressed: "closed_bm_stop",
    edge_compressed_profit: "closed_edge",
    time_exit: "closed_time",
    stop_loss: "closed_sl",
    profit_target: "closed_tp",
    edge_compressed: "closed_edge",
  };
  const status = statusMap[exitDecision.type] || "closed";

  try {
    await pool.query(
      `UPDATE poly_positions SET
        exit_price = $1, pnl_usd = $2, pnl_pct = $3,
        status = $4, closed_at = NOW(),
        resolution = $5
       WHERE id = $6`,
      [exitPrice, pnlUsd, pnlPct, status, exitDecision.type, position.id]
    );

    // Update bankroll
    await pool.query(
      `INSERT INTO poly_bankroll (balance, change_usd, change_reason)
       SELECT COALESCE(
         (SELECT balance FROM poly_bankroll ORDER BY updated_at DESC LIMIT 1), 0
       ) + $1, $1, $2`,
      [pnlUsd, `exit_${exitDecision.type}`]
    );

    logger.info({
      module: "positions",
      positionId: position.id,
      entry: `${(entryPrice * 100).toFixed(1)}¢`,
      exit: `${(exitPrice * 100).toFixed(1)}¢`,
      pnl: `$${pnlUsd.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%)`,
      status,
      holdTime: `${((Date.now() - new Date(position.opened_at).getTime()) / 60000).toFixed(0)}m`,
    }, "Position closed — P&L recorded");
  } catch (err) {
    logger.error({ module: "positions", err: err.message }, "Position close update failed");
  }
}

/**
 * Get summary of all closed positions for performance tracking.
 */
export async function getPerformanceSummary() {
  if (!pool) return null;

  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) as total_trades,
        COUNT(*) FILTER (WHERE pnl_usd > 0) as wins,
        COUNT(*) FILTER (WHERE pnl_usd <= 0) as losses,
        COALESCE(SUM(pnl_usd), 0) as total_pnl,
        COALESCE(AVG(pnl_usd), 0) as avg_pnl,
        COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct,
        COALESCE(AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)) / 60), 0) as avg_hold_minutes,

        -- By exit type
        COUNT(*) FILTER (WHERE status = 'closed_tp') as profit_target_exits,
        COUNT(*) FILTER (WHERE status = 'closed_edge') as edge_compressed_exits,
        COUNT(*) FILTER (WHERE status = 'closed_sl') as stop_loss_exits,
        COUNT(*) FILTER (WHERE status = 'closed_reversal') as reversal_exits,
        COUNT(*) FILTER (WHERE status = 'won') as resolution_wins,
        COUNT(*) FILTER (WHERE status = 'lost') as resolution_losses,

        -- P&L by exit type
        COALESCE(SUM(pnl_usd) FILTER (WHERE status = 'closed_tp'), 0) as tp_pnl,
        COALESCE(SUM(pnl_usd) FILTER (WHERE status = 'closed_edge'), 0) as edge_pnl,
        COALESCE(SUM(pnl_usd) FILTER (WHERE status = 'closed_sl'), 0) as sl_pnl,
        COALESCE(SUM(pnl_usd) FILTER (WHERE status IN ('won', 'lost')), 0) as resolution_pnl

      FROM poly_positions
      WHERE status != 'open'
    `);

    const stats = rows[0];
    const winRate = stats.total_trades > 0
      ? (parseInt(stats.wins) / parseInt(stats.total_trades) * 100).toFixed(1)
      : "0.0";

    return {
      totalTrades: parseInt(stats.total_trades),
      wins: parseInt(stats.wins),
      losses: parseInt(stats.losses),
      winRate: `${winRate}%`,
      totalPnl: parseFloat(stats.total_pnl),
      avgPnl: parseFloat(stats.avg_pnl),
      avgPnlPct: parseFloat(stats.avg_pnl_pct),
      avgHoldMinutes: parseFloat(stats.avg_hold_minutes),
      byExitType: {
        profitTarget: { count: parseInt(stats.profit_target_exits), pnl: parseFloat(stats.tp_pnl) },
        edgeCompressed: { count: parseInt(stats.edge_compressed_exits), pnl: parseFloat(stats.edge_pnl) },
        stopLoss: { count: parseInt(stats.stop_loss_exits), pnl: parseFloat(stats.sl_pnl) },
        reversal: { count: parseInt(stats.reversal_exits), pnl: 0 },
        resolution: {
          wins: parseInt(stats.resolution_wins),
          losses: parseInt(stats.resolution_losses),
          pnl: parseFloat(stats.resolution_pnl),
        },
      },
    };
  } catch (err) {
    logger.error({ module: "positions", err: err.message }, "Performance summary query failed");
    return null;
  }
}
