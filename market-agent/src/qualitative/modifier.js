// ============================================================
// CONVICTION MODIFIER
// Adjusts quant signal confidence based on qualitative context.
// Max adjustment: ±30% per the brief.
// ============================================================

import logger from "../logger.js";

const MAX_ADJUSTMENT = 0.30;

/**
 * Apply qualitative conviction adjustments to composite signals.
 *
 * @param {Object[]} composites - Composite signal objects from scorer
 * @param {Object} qualContext - Output from qualitative/context.js analyze()
 * @returns {Object[]} Adjusted composites with qualitative attribution
 */
export function applyAdjustments(composites, qualContext) {
  if (!qualContext?.available || !qualContext.contradictions?.conviction_adjustments) {
    // No qualitative data — return composites unchanged
    return composites.map((c) => ({
      ...c,
      qualitative_adjustment: 0,
      adjusted_confidence: c.composite_confidence,
      qualitative_available: false,
    }));
  }

  const adjustments = qualContext.contradictions.conviction_adjustments;

  return composites.map((composite) => {
    const pairAdj = adjustments[composite.pair];
    if (!pairAdj) {
      return {
        ...composite,
        qualitative_adjustment: 0,
        adjusted_confidence: composite.composite_confidence,
        qualitative_available: true,
        qualitative_rationale: "No specific adjustment for this pair",
      };
    }

    // Clamp adjustment to ±30%
    const rawAdj = pairAdj.adjustment || 0;
    const clampedAdj = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, rawAdj));

    // Apply to confidence — floor at 0, cap at 1
    const adjusted = Math.max(0, Math.min(1, composite.composite_confidence + clampedAdj));

    // Check if qualitative context flips direction
    let adjustedDirection = composite.direction;
    if (adjusted < 0.05 && composite.direction !== "neutral") {
      adjustedDirection = "neutral"; // Qualitative killed the signal
    }

    const result = {
      ...composite,
      qualitative_adjustment: Math.round(clampedAdj * 1000) / 1000,
      adjusted_confidence: Math.round(adjusted * 1000) / 1000,
      adjusted_direction: adjustedDirection,
      qualitative_available: true,
      qualitative_rationale: pairAdj.rationale || "",
    };

    if (clampedAdj !== 0) {
      logger.info({
        module: "modifier",
        pair: composite.pair,
        original: composite.composite_confidence,
        adjustment: clampedAdj,
        adjusted,
        rationale: pairAdj.rationale,
      }, "Conviction adjusted");
    }

    return result;
  });
}

/**
 * Build qualitative summary for the briefing engine.
 */
export function buildQualSummary(qualContext) {
  if (!qualContext?.available) {
    return {
      available: false,
      regime: "unknown",
      sentiment: 0,
      contradictions: [],
      key_themes: [],
    };
  }

  return {
    available: true,
    regime: qualContext.macroAnalysis?.regime || "unknown",
    regime_confidence: qualContext.macroAnalysis?.regime_confidence || 0,
    sentiment: qualContext.newsSynthesis?.overall_sentiment || 0,
    regime_rationale: qualContext.macroAnalysis?.regime_rationale || "",
    contradictions: qualContext.contradictions?.contradictions || [],
    conviction_adjustments: qualContext.contradictions?.conviction_adjustments || {},
    overall_assessment: qualContext.contradictions?.overall_assessment || "",
    key_themes: [
      ...(qualContext.newsSynthesis?.key_themes || []),
      ...(qualContext.macroAnalysis?.key_risks || []),
    ],
    timestamp: qualContext.timestamp,
  };
}
