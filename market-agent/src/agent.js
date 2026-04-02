// ============================================================
// AGENT ORCHESTRATOR
// Runs the 4-layer pipeline: Ingest → Signals → Qualitative → Synthesis.
// This module owns the cycle logic. server.js owns HTTP + scheduling.
//
// Phase 3 hook point: insert Sentinel verification call between
// composite scoring (step 4) and briefing generation (step 5).
// ============================================================

import logger from "./logger.js";
import config from "./config.js";
import { runAll as ingestAll } from "./ingest/index.js";
import { runAll as signalAll } from "./signals/index.js";
import { analyze as qualAnalyze } from "./qualitative/context.js";
import { applyAdjustments, buildQualSummary } from "./qualitative/modifier.js";
import { generateBriefing } from "./synthesis/briefing.js";
import { saveIngestionSnapshot } from "./db/queries.js";
import { verifyTrade } from "./sentinel/client.js";
import { buildDecisionObject } from "./sentinel/decision.js";
import { createProposal, expireStaleProposals } from "./paper/approval.js";
import { checkExits } from "./paper/tracker.js";
import { checkCircuitBreaker } from "./paper/circuit-breaker.js";
import { shouldRunQualitative, updateCache, getUnchangedCycles } from "./cache/staleness.js";
import { latest as latestPrice } from "./signals/history.js";

// Cached qualitative results for reuse when inputs haven't changed
let previousQualContext = null;
let previousQualSummary = null;

/**
 * Run one complete intelligence cycle.
 *
 * Each layer is independently try-caught so a failure in one layer
 * degrades the output rather than aborting the entire cycle.
 *
 * @param {number} cycleId - Monotonic cycle counter
 * @returns {Object} { briefing, ingestResult, signalResult, qualSummary, qualSkipped, error? }
 */
export async function runCycle(cycleId) {
  logger.info({ cycle: cycleId }, "Cycle starting");

  let ingestResult = null;
  let signalResult = null;
  let qualContext = null;
  let qualSummary = null;
  let adjustedComposites = null;
  let briefing = null;

  // ── Layer 1: Ingest ──
  try {
    ingestResult = await ingestAll();
    logger.info({ cycle: cycleId, total: ingestResult.summary.total }, "Layer 1 (Ingest) complete");

    // Persist raw ingestion data for Phase 2 backtesting replay
    try {
      const snapId = await saveIngestionSnapshot(cycleId, ingestResult.points, ingestResult.summary);
      if (snapId) {
        logger.info({ cycle: cycleId, snapshot_id: snapId, points: ingestResult.points.length }, "Ingestion snapshot persisted");
      }
    } catch (snapErr) {
      logger.error({ cycle: cycleId, err: snapErr.message }, "Ingestion snapshot persistence failed — non-blocking");
    }
  } catch (e) {
    logger.error({ cycle: cycleId, layer: "ingest", err: e.message }, "Layer 1 (Ingest) FAILED");
    return {
      cycle: cycleId,
      timestamp: new Date().toISOString(),
      error: `Ingestion failed: ${e.message}`,
      briefing: null,
    };
  }

  // ── Layer 2: Signal Engine ──
  try {
    signalResult = await signalAll(ingestResult.points, { cycle: cycleId });
    logger.info({ cycle: cycleId, signals: signalResult.signals.length }, "Layer 2 (Signals) complete");
  } catch (e) {
    logger.error({ cycle: cycleId, layer: "signals", err: e.message }, "Layer 2 (Signals) FAILED — proceeding with empty signals");
    signalResult = { composites: [], signals: [], summary: { total_signals: 0 } };
  }

  // ── Layer 2.5: Update staleness cache ──
  updateCache(ingestResult);

  // ── Layer 3: Qualitative Context ──
  try {
    if (shouldRunQualitative(ingestResult)) {
      const newsPoints = ingestResult.points.filter((p) => p.type === "news");
      qualContext = await qualAnalyze(newsPoints, signalResult.signals, cycleId);
      qualSummary = buildQualSummary(qualContext);
      // Cache for reuse on skipped cycles
      previousQualContext = qualContext;
      previousQualSummary = qualSummary;
      logger.info({ cycle: cycleId, hasQual: qualContext.available }, "Layer 3 (Qualitative) complete");
    } else {
      qualContext = previousQualContext || { available: false };
      qualSummary = previousQualSummary || { available: false, regime: "unknown", sentiment: 0, contradictions: [], key_themes: [] };
      logger.info({ cycle: cycleId, unchangedCycles: getUnchangedCycles() }, "Layer 3 (Qualitative) skipped — inputs unchanged");
    }
  } catch (e) {
    logger.error({ cycle: cycleId, layer: "qualitative", err: e.message }, "Layer 3 (Qualitative) FAILED — proceeding without qualitative context");
    qualContext = { available: false };
    qualSummary = { available: false, regime: "unknown", sentiment: 0, contradictions: [], key_themes: [] };
  }

  // ── Layer 3.5: Apply conviction adjustments ──
  try {
    adjustedComposites = applyAdjustments(signalResult.composites, qualContext);
  } catch (e) {
    logger.error({ cycle: cycleId, layer: "adjustments", err: e.message }, "Conviction adjustments FAILED — using raw composites");
    adjustedComposites = signalResult.composites;
  }

  // ── Phase 3: Sentinel Verification + Paper Trading ──
  let sentinelResults = {};
  try {
    // Expire any stale proposals from previous cycles
    await expireStaleProposals();

    // Check circuit breaker before proceeding with new proposals
    const breaker = await checkCircuitBreaker();
    if (!breaker.allowed) {
      logger.warn({
        cycle: cycleId,
        reason: breaker.reason,
        details: breaker.details,
      }, "Circuit breaker TRIPPED — pausing new trade proposals");
    }

    for (const composite of adjustedComposites) {
      if (composite.direction !== "neutral" && composite.composite_confidence >= 0.5) {
        const decision = buildDecisionObject(composite, cycleId);
        const verification = await verifyTrade(decision);
        sentinelResults[composite.pair] = verification;

        if (!verification.approved) {
          logger.warn({
            cycle: cycleId,
            pair: composite.pair,
            reason: verification.reason,
            verdict: verification.verdict,
          }, "Sentinel BLOCKED trade");
        } else if (!breaker.allowed) {
          // Circuit breaker is active — skip proposal creation
          logger.warn({
            cycle: cycleId,
            pair: composite.pair,
            breakerReason: breaker.reason,
          }, "Sentinel approved but circuit breaker blocked proposal creation");
        } else {
          // Sentinel approved and circuit breaker OK — create trade proposal for human review
          const priceData = latestPrice(composite.pair);
          const currentPrice = priceData?.price || 0;
          await createProposal({
            pair: composite.pair,
            direction: composite.direction,
            confidence: composite.composite_confidence,
            sentinelVerdict: verification.verdict,
            sentinelDetails: verification.details,
            signalAttribution: composite.attribution,
            decisionObject: decision,
            currentPrice,
          });
          logger.info({ cycle: cycleId, pair: composite.pair, price: currentPrice, verdict: verification.verdict }, "Trade proposal created — awaiting human approval");
        }

        // Check paper position exits against current price
        const pricePoint = latestPrice(composite.pair);
        const currentPrice = pricePoint?.price || 0;
        if (currentPrice > 0) {
          await checkExits(composite.pair, currentPrice);
        }
      }
    }
  } catch (e) {
    logger.error({ cycle: cycleId, err: e.message }, "Phase 3 (Sentinel/Paper) error — non-blocking");
  }

  // ── Sentinel health ping (Render keepalive) ──
  try {
    const res = await fetch(`${config.sentinel.url}/health`, { signal: AbortSignal.timeout(5000) });
    const sentinelHealth = await res.json();
    logger.debug({ cycle: cycleId, sentinel: sentinelHealth.status }, "Sentinel health ping");
  } catch (e) {
    logger.warn({ cycle: cycleId }, "Sentinel health ping failed — Render may be spinning down");
  }

  // ── Layer 4: Synthesis & Briefing ──
  try {
    briefing = await generateBriefing({
      cycle: cycleId,
      ingestSummary: ingestResult.summary,
      signals: signalResult.signals,
      composites: adjustedComposites,
      qualSummary,
    });
    logger.info({ cycle: cycleId, ideas: briefing.trade_ideas?.length }, "Layer 4 (Briefing) complete");
  } catch (e) {
    logger.error({ cycle: cycleId, layer: "briefing", err: e.message }, "Layer 4 (Briefing) FAILED");
  }

  return {
    cycle: cycleId,
    timestamp: new Date().toISOString(),
    ingestSummary: ingestResult?.summary || {},
    signalSummary: signalResult?.summary || {},
    briefing,
    sentinelResults,
  };
}
