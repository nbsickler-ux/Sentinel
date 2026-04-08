// ============================================================
// ORDER MANAGER
// Manages order lifecycle: proposal → approval → execution → tracking.
// Supports both directional trades and market-making.
// ============================================================

import { pool } from "../db/schema.js";
import config from "../config.js";
import logger from "../logger.js";
import { placeLimitOrder, cancelOrder, getOrderbook } from "./polymarket.js";
import { checkCircuitBreaker } from "../risk/circuit-breaker.js";
import { calculatePositionSize, calculateMarketMakingOrders } from "../risk/sizing.js";

// ── PROPOSAL MANAGEMENT ──

/**
 * Create a trade proposal from an analysis result.
 * Proposals require human approval before execution (Phase 1).
 */
export async function createProposal(analysis, bankroll, sizeMultiplier = 1.0) {
  // Calculate position size
  const sizing = calculatePositionSize({
    ourProbability: analysis.fair_probability,
    marketPrice: analysis.direction === "buy_yes" ? analysis.market_yes_price : (1 - analysis.market_yes_price),
    confidence: analysis.confidence,
    bankroll,
    sizeMultiplier,
    direction: analysis.direction,
  });

  if (!sizing.trade) {
    logger.debug({
      module: "manager",
      market: analysis.market_question?.slice(0, 50),
      reason: sizing.reason,
    }, "No trade — sizing gate");
    return null;
  }

  // Determine entry price (we place limit orders slightly better than market)
  const entryPrice = analysis.direction === "buy_yes"
    ? analysis.market_yes_price - 0.005  // Bid 0.5¢ below market
    : (1 - analysis.market_no_price) - 0.005;

  const proposal = {
    condition_id: analysis.condition_id,
    market_question: analysis.market_question,
    direction: analysis.direction,
    entry_price: Math.round(entryPrice * 1000) / 1000,
    size_usd: sizing.size,
    edge_cents: sizing.edge,
    confidence: analysis.confidence,
    kelly_fraction: sizing.kelly,
    analysis_summary: analysis.rationale || "",
  };

  // Persist to DB
  if (pool) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO poly_proposals (
          condition_id, market_question, direction, entry_price,
          size_usd, edge_cents, confidence, kelly_fraction,
          analysis_summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
        [
          proposal.condition_id, proposal.market_question, proposal.direction,
          proposal.entry_price, proposal.size_usd, proposal.edge_cents,
          proposal.confidence, proposal.kelly_fraction, proposal.analysis_summary,
        ]
      );
      proposal.id = rows[0].id;
    } catch (err) {
      logger.error({ module: "manager", err: err.message }, "Proposal insert failed");
    }
  }

  logger.info({
    module: "manager",
    market: proposal.market_question?.slice(0, 60),
    direction: proposal.direction,
    size: `$${proposal.size_usd}`,
    edge: `${proposal.edge_cents.toFixed(1)}¢`,
    confidence: `${(proposal.confidence * 100).toFixed(0)}%`,
  }, "Trade proposal created");

  return proposal;
}

/**
 * Approve a pending proposal and execute the trade.
 */
export async function approveProposal(proposalId) {
  if (!pool) return { success: false, reason: "No database" };

  // Check circuit breaker first
  const breaker = await checkCircuitBreaker();
  if (!breaker.allowed) {
    logger.warn({ module: "manager", proposalId, reason: breaker.reason }, "Circuit breaker blocked approval");
    return { success: false, reason: breaker.reason };
  }

  try {
    // Fetch proposal
    const { rows } = await pool.query(
      `SELECT * FROM poly_proposals WHERE id = $1 AND status = 'pending'`,
      [proposalId]
    );

    if (rows.length === 0) {
      return { success: false, reason: "Proposal not found or already decided" };
    }

    const proposal = rows[0];

    // Check expiry
    if (new Date(proposal.expires_at) < new Date()) {
      await pool.query(
        `UPDATE poly_proposals SET status = 'expired', decided_at = NOW() WHERE id = $1`,
        [proposalId]
      );
      return { success: false, reason: "Proposal expired" };
    }

    // Mark approved
    await pool.query(
      `UPDATE poly_proposals SET status = 'approved', decided_at = NOW() WHERE id = $1`,
      [proposalId]
    );

    // Execute the trade
    const result = await executeTrade(proposal);
    return result;
  } catch (err) {
    logger.error({ module: "manager", proposalId, err: err.message }, "Approval failed");
    return { success: false, reason: err.message };
  }
}

/**
 * Reject a proposal.
 */
export async function rejectProposal(proposalId) {
  if (!pool) return;
  await pool.query(
    `UPDATE poly_proposals SET status = 'rejected', decided_at = NOW() WHERE id = $1`,
    [proposalId]
  );
  logger.info({ module: "manager", proposalId }, "Proposal rejected");
}

/**
 * Get all pending proposals.
 */
export async function getPendingProposals() {
  if (!pool) return [];
  try {
    const { rows } = await pool.query(
      `SELECT * FROM poly_proposals
       WHERE status = 'pending' AND expires_at > NOW()
       ORDER BY created_at DESC`
    );
    return rows;
  } catch (err) {
    logger.error({ module: "manager", err: err.message }, "Failed to fetch proposals");
    return [];
  }
}

// ── TRADE EXECUTION ──

/**
 * Execute a directional trade by placing a limit order.
 */
async function executeTrade(proposal) {
  // TODO: Map condition_id to actual token_id
  // For now, we need the market's token list
  const tokenId = proposal.token_id; // Must be set by caller or resolved

  if (!tokenId) {
    logger.warn({ module: "manager" }, "No token_id — skipping execution (paper mode)");

    // Record as paper position
    if (pool) {
      await pool.query(
        `INSERT INTO poly_positions (
          condition_id, token_id, market_question, direction,
          entry_price, size_usd, edge_at_entry, confidence_at_entry,
          kelly_fraction, status
        ) VALUES ($1, 'paper', $2, $3, $4, $5, $6, $7, $8, 'open')`,
        [
          proposal.condition_id, proposal.market_question, proposal.direction,
          proposal.entry_price, proposal.size_usd, proposal.edge_cents,
          proposal.confidence, proposal.kelly_fraction,
        ]
      );
    }

    return { success: true, mode: "paper", proposal };
  }

  // Real execution via CLOB
  const side = proposal.direction === "buy_yes" ? "BUY" : "BUY"; // Buying the relevant token
  const result = await placeLimitOrder({
    tokenId,
    side,
    price: proposal.entry_price,
    size: proposal.size_usd,
  });

  if (result?.orderID) {
    // Record position
    if (pool) {
      await pool.query(
        `INSERT INTO poly_positions (
          condition_id, token_id, market_question, direction,
          entry_price, size_usd, edge_at_entry, confidence_at_entry,
          kelly_fraction, order_id, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')`,
        [
          proposal.condition_id, tokenId, proposal.market_question,
          proposal.direction, proposal.entry_price, proposal.size_usd,
          proposal.edge_cents, proposal.confidence, proposal.kelly_fraction,
          result.orderID,
        ]
      );
    }

    return { success: true, mode: "live", orderId: result.orderID, proposal };
  }

  return { success: false, reason: "Order placement failed" };
}

// ── MARKET MAKING ──

/**
 * Place market-making orders around our fair value estimate.
 * Posts limit orders on both sides — earns spread + 0.20% maker rebate.
 */
export async function placeMarketMakingOrders({
  conditionId,
  tokenIdYes,
  tokenIdNo,
  fairValue,
  confidence,
  bankroll,
  sizeMultiplier = 1.0,
}) {
  const orders = calculateMarketMakingOrders({
    fairValue,
    confidence,
    bankroll,
    sizeMultiplier,
  });

  if (!orders.make) {
    return { placed: false, reason: orders.reason };
  }

  const results = { bid: null, ask: null };

  // Place bid (buy YES below fair value)
  if (tokenIdYes) {
    results.bid = await placeLimitOrder({
      tokenId: tokenIdYes,
      side: "BUY",
      price: orders.bid.price,
      size: orders.bid.size,
    });
  }

  // Place ask (buy NO above fair value, which is equivalent to selling YES)
  if (tokenIdNo) {
    results.ask = await placeLimitOrder({
      tokenId: tokenIdNo,
      side: "BUY",
      price: 1 - orders.ask.price, // Buy NO at complementary price
      size: orders.ask.size,
    });
  }

  logger.info({
    module: "manager",
    conditionId: conditionId?.slice(0, 12),
    bidPrice: orders.bid.price,
    askPrice: orders.ask.price,
    size: `$${orders.bid.size}`,
    spread: `${orders.spreadCents}¢`,
  }, "Market-making orders placed");

  return {
    placed: true,
    bid: results.bid,
    ask: results.ask,
    orders,
  };
}

// ── POSITION TRACKING ──

/**
 * Get all open positions.
 */
export async function getOpenPositions() {
  if (!pool) return [];
  try {
    const { rows } = await pool.query(
      `SELECT * FROM poly_positions WHERE status = 'open' ORDER BY opened_at DESC`
    );
    return rows;
  } catch (err) {
    logger.error({ module: "manager", err: err.message }, "Failed to fetch open positions");
    return [];
  }
}

/**
 * Close a position when the market resolves.
 *
 * @param {number} positionId - Position to close
 * @param {boolean} outcome - true if YES won, false if NO won
 */
export async function resolvePosition(positionId, outcome) {
  if (!pool) return;

  try {
    const { rows } = await pool.query(
      `SELECT * FROM poly_positions WHERE id = $1`,
      [positionId]
    );
    if (rows.length === 0) return;

    const pos = rows[0];
    const isYesBet = pos.direction === "buy_yes" || pos.direction === "maker_bid";
    const won = (isYesBet && outcome) || (!isYesBet && !outcome);

    const exitPrice = outcome ? 1.0 : 0.0;
    const pnlUsd = won
      ? pos.size_usd * ((1.0 - pos.entry_price) / pos.entry_price) // Win: (1 - entry) / entry
      : -pos.size_usd; // Loss: lose entire stake
    const pnlPct = pnlUsd / pos.size_usd;

    await pool.query(
      `UPDATE poly_positions SET
        exit_price = $1, pnl_usd = $2, pnl_pct = $3,
        status = $4, closed_at = NOW(), resolution = $5
       WHERE id = $6`,
      [exitPrice, pnlUsd, pnlPct, won ? "won" : "lost", outcome ? "YES" : "NO", positionId]
    );

    // Update bankroll
    await pool.query(
      `INSERT INTO poly_bankroll (balance, change_usd, change_reason)
       SELECT COALESCE(
         (SELECT balance FROM poly_bankroll ORDER BY updated_at DESC LIMIT 1), 0
       ) + $1, $1, 'trade_pnl'`,
      [pnlUsd]
    );

    logger.info({
      module: "manager",
      positionId,
      market: pos.market_question?.slice(0, 50),
      direction: pos.direction,
      outcome: outcome ? "YES" : "NO",
      pnl: `$${pnlUsd.toFixed(2)}`,
      won,
    }, "Position resolved");
  } catch (err) {
    logger.error({ module: "manager", positionId, err: err.message }, "Position resolution failed");
  }
}
