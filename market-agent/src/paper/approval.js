// ============================================================
// HUMAN APPROVAL GATE
// All paper trades require human approval before execution.
// Proposals expire after 15 minutes if not acted on.
// ============================================================

import crypto from "crypto";
import { pool } from "../db/schema.js";
import { openPosition } from "./tracker.js";
import { checkCircuitBreaker } from "./circuit-breaker.js";
import logger from "../logger.js";

const EXPIRY_MINUTES = 15;

/**
 * Create a trade proposal requiring human approval.
 *
 * @param {Object} params
 * @returns {string} proposal_id
 */
export async function createProposal(params) {
  const proposalId = `prop_${crypto.randomBytes(8).toString("hex")}`;
  const expiresAt = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000);

  await pool.query(
    `INSERT INTO trade_proposals
      (proposal_id, pair, direction, confidence, sentinel_verdict,
       sentinel_details, signal_attribution, decision_object, current_price, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      proposalId,
      params.pair,
      params.direction,
      params.confidence,
      params.sentinelVerdict,
      JSON.stringify(params.sentinelDetails || {}),
      JSON.stringify(params.signalAttribution || {}),
      JSON.stringify(params.decisionObject || {}),
      params.currentPrice,
      expiresAt,
    ]
  );

  logger.info({ module: "approval", proposalId, pair: params.pair, direction: params.direction, expiresAt: expiresAt.toISOString() }, "Trade proposal created");
  return proposalId;
}

/**
 * Approve a pending proposal — opens a paper position.
 * Checks circuit breaker before approval to ensure no safeguards are violated.
 *
 * @param {string} proposalId
 * @returns {Object} { success, tradeId?, error? }
 */
export async function approveProposal(proposalId) {
  const { rows } = await pool.query(
    `SELECT * FROM trade_proposals WHERE proposal_id = $1 AND status = 'pending'`,
    [proposalId]
  );

  if (rows.length === 0) {
    return { success: false, error: "Proposal not found or not pending" };
  }

  const proposal = rows[0];

  if (new Date(proposal.expires_at) < new Date()) {
    await pool.query(
      `UPDATE trade_proposals SET status = 'expired' WHERE proposal_id = $1`,
      [proposalId]
    );
    return { success: false, error: "Proposal expired" };
  }

  // Check circuit breaker before approval
  const breaker = await checkCircuitBreaker();
  if (!breaker.allowed) {
    logger.warn({
      module: "approval",
      proposalId,
      breakerReason: breaker.reason,
      breakerDetails: breaker.details,
    }, "Circuit breaker blocked proposal approval");
    return { success: false, error: `Circuit breaker active: ${breaker.reason}` };
  }

  const tradeId = await openPosition({
    pair: proposal.pair,
    direction: proposal.direction,
    entryPrice: parseFloat(proposal.current_price),
    confidence: parseFloat(proposal.confidence),
    sentinelVerdict: proposal.sentinel_verdict,
    sentinelDetails: proposal.sentinel_details,
    signalAttribution: proposal.signal_attribution,
    decisionObject: proposal.decision_object,
  });

  await pool.query(
    `UPDATE trade_proposals SET status = 'approved', decided_at = NOW() WHERE proposal_id = $1`,
    [proposalId]
  );

  // Mark the paper trade as human-approved
  await pool.query(
    `UPDATE paper_trades SET human_approved = true, human_approved_at = NOW() WHERE trade_id = $1`,
    [tradeId]
  );

  logger.info({ module: "approval", proposalId, tradeId }, "Proposal approved — paper position opened");
  return { success: true, tradeId };
}

/**
 * Reject a pending proposal.
 *
 * @param {string} proposalId
 * @returns {Object} { success }
 */
export async function rejectProposal(proposalId) {
  const result = await pool.query(
    `UPDATE trade_proposals SET status = 'rejected', decided_at = NOW()
     WHERE proposal_id = $1 AND status = 'pending' RETURNING proposal_id`,
    [proposalId]
  );

  if (result.rows.length === 0) {
    return { success: false, error: "Proposal not found or not pending" };
  }

  logger.info({ module: "approval", proposalId }, "Proposal rejected");
  return { success: true };
}

/**
 * Expire proposals past their expiry time. Called each cycle.
 *
 * @returns {number} Count of expired proposals
 */
export async function expireStaleProposals() {
  const result = await pool.query(
    `UPDATE trade_proposals SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW() RETURNING proposal_id`
  );

  if (result.rows.length > 0) {
    logger.info({ module: "approval", count: result.rows.length }, "Expired stale proposals");
  }
  return result.rows.length;
}

/**
 * Get all pending proposals.
 */
export async function getPendingProposals() {
  const { rows } = await pool.query(
    `SELECT * FROM trade_proposals WHERE status = 'pending' ORDER BY created_at DESC`
  );
  return rows;
}
