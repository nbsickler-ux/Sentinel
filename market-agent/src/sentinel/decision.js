// ============================================================
// DECISION OBJECT BUILDER
// Maps composite signal output to Sentinel's expected format.
// ============================================================

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";

/**
 * Build a Sentinel decision object from a composite signal.
 *
 * @param {Object} composite - Composite signal from scorer.js
 * @param {number} cycleId - Current cycle number
 * @param {number} [positionSizeUsd=50] - Position size in USD
 * @returns {Object} Decision object for Sentinel verification
 */
export function buildDecisionObject(composite, cycleId, positionSizeUsd = 50) {
  return {
    agent_id: "market-agent-v1",
    action: "swap",
    target_contract: AERODROME_ROUTER,
    chain: "base",
    token_in: composite.direction === "long" ? USDC_ADDRESS : CBBTC_ADDRESS,
    token_out: composite.direction === "long" ? CBBTC_ADDRESS : USDC_ADDRESS,
    amount_usd: positionSizeUsd,
    direction: composite.direction,
    confidence: composite.composite_confidence,
    regime: composite.regime,
    signal_agreement: composite.agreement_ratio,
    thesis: `Composite signal: ${composite.direction} with ${composite.composite_confidence} confidence. Attribution: ${JSON.stringify(composite.attribution)}`,
    cycle: cycleId,
  };
}
