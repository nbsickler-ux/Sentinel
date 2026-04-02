// ============================================================
// PAPER TRADING POSITION TRACKER
// Virtual position management with triple barrier exits.
// All state stored in Postgres paper_trades table.
// ============================================================

import crypto from "crypto";
import { pool } from "../db/schema.js";
import logger from "../logger.js";

const TP_PCT = 3.0;
const SL_PCT = 5.0;
const TIME_LIMIT_MS = 48 * 60 * 60 * 1000;
const FEE_BPS = 30;

/**
 * Open a new paper position.
 *
 * @param {Object} params
 * @returns {string} trade_id
 */
export async function openPosition(params) {
  const tradeId = `pt_${crypto.randomBytes(8).toString("hex")}`;

  await pool.query(
    `INSERT INTO paper_trades
      (trade_id, pair, direction, entry_price, entry_time, confidence,
       sentinel_verdict, sentinel_details, signal_attribution, decision_object, position_size_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      tradeId,
      params.pair,
      params.direction,
      params.entryPrice,
      new Date(),
      params.confidence,
      params.sentinelVerdict,
      JSON.stringify(params.sentinelDetails || {}),
      JSON.stringify(params.signalAttribution || {}),
      JSON.stringify(params.decisionObject || {}),
      params.positionSizePct || 0.5,
    ]
  );

  logger.info({ module: "paper", tradeId, pair: params.pair, direction: params.direction, price: params.entryPrice }, "Paper position opened");
  return tradeId;
}

/**
 * Check all open positions against current price for triple barrier exits.
 *
 * @param {string} pair
 * @param {number} currentPrice
 * @returns {Object[]} Array of trades that were just closed
 */
export async function checkExits(pair, currentPrice) {
  const { rows: openPositions } = await pool.query(
    `SELECT * FROM paper_trades WHERE status = 'open' AND pair = $1`,
    [pair]
  );

  const closed = [];
  const now = new Date();

  for (const pos of openPositions) {
    const entryPrice = parseFloat(pos.entry_price);
    const entryTime = new Date(pos.entry_time);
    const elapsed = now.getTime() - entryTime.getTime();

    let exitReason = null;
    let exitPrice = currentPrice;

    if (pos.direction === "long") {
      const tpPrice = entryPrice * (1 + TP_PCT / 100);
      const slPrice = entryPrice * (1 - SL_PCT / 100);
      if (currentPrice >= tpPrice) exitReason = "closed_tp";
      else if (currentPrice <= slPrice) exitReason = "closed_sl";
    } else {
      const tpPrice = entryPrice * (1 - TP_PCT / 100);
      const slPrice = entryPrice * (1 + SL_PCT / 100);
      if (currentPrice <= tpPrice) exitReason = "closed_tp";
      else if (currentPrice >= slPrice) exitReason = "closed_sl";
    }

    if (!exitReason && elapsed >= TIME_LIMIT_MS) {
      exitReason = "closed_tl";
    }

    if (exitReason) {
      const rawPnlPct = pos.direction === "long"
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100;
      const pnlBps = rawPnlPct * 100 - FEE_BPS;

      await pool.query(
        `UPDATE paper_trades SET status = $1, exit_price = $2, exit_time = $3, pnl_bps = $4 WHERE trade_id = $5`,
        [exitReason, exitPrice, now, pnlBps, pos.trade_id]
      );

      logger.info({ module: "paper", tradeId: pos.trade_id, exitReason, pnlBps: pnlBps.toFixed(1) }, "Paper position closed");
      closed.push({ ...pos, status: exitReason, exit_price: exitPrice, exit_time: now, pnl_bps: pnlBps });
    }
  }

  return closed;
}

/**
 * Get all open paper positions.
 */
export async function getOpenPositions() {
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades WHERE status = 'open' ORDER BY entry_time DESC`
  );
  return rows;
}

/**
 * Get closed paper trade history.
 */
export async function getTradeHistory(limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades WHERE status != 'open' ORDER BY exit_time DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Get aggregate paper trading performance metrics.
 */
export async function getPaperMetrics() {
  const { rows } = await pool.query(
    `SELECT * FROM paper_trades WHERE status != 'open' ORDER BY exit_time ASC`
  );

  if (rows.length === 0) {
    return { totalTrades: 0, winRate: 0, avgPnlBps: 0, totalPnlBps: 0, sharpeRatio: 0 };
  }

  const pnls = rows.map((r) => parseFloat(r.pnl_bps));
  const wins = pnls.filter((p) => p > 0).length;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const avgPnl = totalPnl / pnls.length;

  const variance = pnls.reduce((sum, p) => sum + (p - avgPnl) ** 2, 0) / (pnls.length - 1 || 1);
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (avgPnl / stdDev) * Math.sqrt(252) : 0;

  return {
    totalTrades: rows.length,
    winRate: Math.round((wins / rows.length) * 1000) / 1000,
    avgPnlBps: Math.round(avgPnl * 100) / 100,
    totalPnlBps: Math.round(totalPnl * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
  };
}
