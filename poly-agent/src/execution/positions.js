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
import { placeLimitOrder, cancelOrder, getOrderbook } from "./polymarket.js";
import { estimateFairValue } from "../analysis/engine.js";

const {
  edgeCompressedCents,
  profitTargetCents,
  stopLossCents,
  holdThroughMinEdgeCents,
  checkIntervalMs,
} = config.exits;

/**
 * Evaluate exit conditions for all open positions.
 * Called on every odds scan cycle.
 *
 * @param {Map} latestOdds - condition_id → { yes, no, timestamp }
 * @param {Map} analysisResults - condition_id → latest fair value estimate
 */
export async function evaluateExits(latestOdds, analysisResults) {
  if (!pool) return [];

  const exits = [];

  try {
    const { rows: positions } = await pool.query(
      `SELECT * FROM poly_positions WHERE status = 'open' ORDER BY opened_at ASC`
    );

    for (const pos of positions) {
      const odds = latestOdds.get(pos.condition_id);
      if (!odds) continue; // No current price data

      const analysis = analysisResults.get(pos.condition_id);
      const currentPrice = pos.direction === "buy_yes" ? odds.yes : odds.no;
      const entryPrice = parseFloat(pos.entry_price);
      const priceDelta = (currentPrice - entryPrice) * 100; // In cents, positive = profit

      const exitDecision = evaluateSinglePosition({
        position: pos,
        currentPrice,
        entryPrice,
        priceDelta,
        analysis,
        odds,
      });

      if (exitDecision.shouldExit) {
        exits.push({ position: pos, ...exitDecision });

        // Execute the exit
        if (config.mode !== "analysis") {
          await executeExit(pos, exitDecision, currentPrice);
        } else {
          // Analysis mode: log the exit as if it happened
          await recordPaperExit(pos, exitDecision, currentPrice);
        }
      }
    }

    if (exits.length > 0) {
      logger.info({
        module: "positions",
        exits: exits.length,
        reasons: exits.map((e) => e.reason),
      }, "Position exits evaluated");
    }

    return exits;
  } catch (err) {
    logger.error({ module: "positions", err: err.message }, "Exit evaluation failed");
    return [];
  }
}

/**
 * Evaluate exit conditions for a single position.
 * Returns { shouldExit, reason, type, urgency }
 */
function evaluateSinglePosition({ position, currentPrice, entryPrice, priceDelta, analysis, odds }) {
  // ── STOP LOSS: Hard exit on adverse move ──
  if (priceDelta <= -stopLossCents) {
    return {
      shouldExit: true,
      reason: `Stop loss: ${priceDelta.toFixed(1)}¢ move against (limit: -${stopLossCents}¢)`,
      type: "stop_loss",
      urgency: "immediate",
      priceDelta,
    };
  }

  // ── PROFIT TARGET: Take profit on strong favorable move ──
  if (priceDelta >= profitTargetCents) {
    return {
      shouldExit: true,
      reason: `Profit target: +${priceDelta.toFixed(1)}¢ (target: +${profitTargetCents}¢)`,
      type: "profit_target",
      urgency: "normal",
      priceDelta,
    };
  }

  // ── EDGE COMPRESSION: Market caught up to our estimate ──
  // This is the most important exit. Our edge was speed — once the
  // market reflects the information, holding is pure gambling.
  if (analysis) {
    const currentEdge = calculateCurrentEdge(position, analysis, currentPrice);

    if (priceDelta > 0 && Math.abs(currentEdge) <= edgeCompressedCents) {
      return {
        shouldExit: true,
        reason: `Edge compressed: remaining edge ${currentEdge.toFixed(1)}¢ (threshold: ${edgeCompressedCents}¢). Profit: +${priceDelta.toFixed(1)}¢`,
        type: "edge_compressed",
        urgency: "normal",
        priceDelta,
        remainingEdge: currentEdge,
      };
    }
  }

  // ── RE-EVALUATION: Our analysis changed direction ──
  if (analysis && analysis.direction) {
    const ourSide = position.direction; // buy_yes or buy_no
    const claudeNow = analysis.direction;

    // If Claude now says the other side, or no_trade, and we're not in profit
    if (claudeNow !== ourSide && claudeNow !== "no_trade" && priceDelta < 2) {
      return {
        shouldExit: true,
        reason: `Analysis flipped: entered ${ourSide}, Claude now says ${claudeNow}. P&L: ${priceDelta.toFixed(1)}¢`,
        type: "analysis_reversal",
        urgency: "normal",
        priceDelta,
      };
    }
  }

  // ── HOLD THROUGH RESOLUTION CHECK ──
  // If the event is about to resolve, decide whether to hold or sell
  // Only relevant if the position is in profit and has remaining edge
  // (Otherwise stop-loss or profit-target would have caught it)

  // No exit triggered
  return {
    shouldExit: false,
    reason: null,
    priceDelta,
    currentPrice,
  };
}

/**
 * Calculate the current edge given updated analysis.
 * Positive = still in our favor. Negative = market moved past our estimate.
 */
function calculateCurrentEdge(position, analysis, currentPrice) {
  if (!analysis?.fair_probability) return 0;

  if (position.direction === "buy_yes") {
    return (analysis.fair_probability - currentPrice) * 100;
  } else {
    return ((1 - analysis.fair_probability) - (1 - currentPrice)) * 100;
  }
}

/**
 * Execute a position exit by placing a sell order.
 */
async function executeExit(position, exitDecision, currentPrice) {
  try {
    // Place a limit sell slightly below current price for quick fill
    const sellPrice = currentPrice - 0.005; // 0.5¢ below market for fast fill

    if (position.token_id && position.token_id !== "paper") {
      // Sell by buying the opposite token
      // In Polymarket, selling YES shares = buying NO shares at complementary price
      const result = await placeLimitOrder({
        tokenId: position.token_id, // TODO: need opposite token for sell
        side: "SELL",
        price: sellPrice,
        size: parseFloat(position.size_usd),
      });

      if (result?.orderID) {
        await updatePositionClosed(position, exitDecision, currentPrice);
        logger.info({
          module: "positions",
          market: position.market_question?.slice(0, 50),
          type: exitDecision.type,
          pnl: `${exitDecision.priceDelta >= 0 ? "+" : ""}${exitDecision.priceDelta.toFixed(1)}¢`,
          orderId: result.orderID,
        }, "Position exited (live)");
      }
    } else {
      // Paper position — just update status
      await updatePositionClosed(position, exitDecision, currentPrice);
    }
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
    stop_loss: "closed_sl",
    profit_target: "closed_tp",
    edge_compressed: "closed_edge",
    analysis_reversal: "closed_reversal",
    hold_expired: "closed_expired",
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
