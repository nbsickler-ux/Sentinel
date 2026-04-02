// ============================================================
// PROMPT TEMPLATES
// System and user prompts for Claude API qualitative analysis.
// Prompt quality is a first-class concern per the brief.
//
// VERSION HISTORY:
//   1.0 (2026-03-28) — Initial prompt set: news synthesis, macro analysis, contradiction detection.
//   1.1 (2026-03-30) — Added veAERO context to system prompt, version tracking.
// ============================================================

/**
 * Prompt version. Logged with each Claude API call for A/B tracking in Phase 2.
 */
export const PROMPT_VERSION = "1.1";

/**
 * System prompt: establishes Claude's role as a market analyst.
 */
export const SYSTEM_PROMPT = `You are a quantitative market analyst specializing in DeFi and crypto markets on Base L2. You analyze news, macro data, and on-chain signals to produce structured assessments that adjust quantitative trading signals.

Your analysis must be:
- Objective and evidence-based — cite specific data points
- Concise — no filler, every sentence carries information
- Structured — always output valid JSON matching the requested schema
- Calibrated — your confidence adjustments should be proportional to evidence strength

You monitor three pairs on Aerodrome Finance (Base DEX):
1. cbBTC/USDC — CEX/DEX arbitrage + momentum edge
2. ETH/USDC — macro regime sensitivity
3. AERO/USDC — protocol-native behavioral edge (veAERO locks, governance, emissions)

Never fabricate data. If information is insufficient, say so and assign neutral adjustments.`;

/**
 * Build the news synthesis prompt.
 * Takes recent news articles and produces relevance-scored summaries.
 */
export function newsSynthesisPrompt(articles) {
  const articleList = articles
    .map((a, i) => `[${i + 1}] "${a.title}" — ${a.source} (${a.published_at})\n    ${a.description || "No description"}`)
    .join("\n\n");

  return `Analyze these recent news articles for their impact on our three trading pairs (cbBTC/USDC, ETH/USDC, AERO/USDC).

ARTICLES:
${articleList}

Respond with JSON only:
{
  "articles": [
    {
      "index": 1,
      "relevance": "high|medium|low|none",
      "affected_pairs": ["ETH/USDC"],
      "sentiment": -1.0 to 1.0,
      "key_signal": "one sentence summary of the tradeable signal",
      "time_horizon": "immediate|short_term|medium_term"
    }
  ],
  "overall_sentiment": -1.0 to 1.0,
  "regime_signal": "risk_on|risk_off|neutral|transitioning",
  "key_themes": ["theme1", "theme2"]
}`;
}

/**
 * Build the macro analysis prompt.
 * Takes FRED indicators and produces regime classification.
 */
export function macroAnalysisPrompt(indicators) {
  const indList = indicators
    .map((ind) => `- ${ind.indicator} (${ind.series_id}): ${ind.value} ${ind.unit} (prev: ${ind.previous}, delta: ${ind.delta})`)
    .join("\n");

  return `Analyze these macro indicators for their impact on crypto/DeFi markets, specifically our Base L2 pairs.

INDICATORS:
${indList}

Respond with JSON only:
{
  "regime": "risk_on|risk_off|neutral|transitioning",
  "regime_confidence": 0.0 to 1.0,
  "regime_rationale": "2-3 sentence explanation",
  "pair_impacts": {
    "cbBTC/USDC": { "bias": "bullish|bearish|neutral", "strength": 0.0 to 1.0, "rationale": "one sentence" },
    "ETH/USDC": { "bias": "bullish|bearish|neutral", "strength": 0.0 to 1.0, "rationale": "one sentence" },
    "AERO/USDC": { "bias": "bullish|bearish|neutral", "strength": 0.0 to 1.0, "rationale": "one sentence" }
  },
  "key_risks": ["risk1", "risk2"]
}`;
}

/**
 * Build the contradiction detection prompt.
 * Takes quant signals + qualitative context and flags conflicts.
 */
export function contradictionPrompt(quantSignals, qualContext) {
  const signalSummary = quantSignals
    .map((s) => `- ${s.pair} ${s.type}: ${s.direction} (${s.confidence}) — ${s.thesis}`)
    .join("\n");

  return `Compare these quantitative signals against the qualitative context and identify contradictions.

QUANTITATIVE SIGNALS:
${signalSummary}

QUALITATIVE CONTEXT:
- News sentiment: ${qualContext.newsSentiment ?? "N/A"}
- Macro regime: ${qualContext.macroRegime ?? "N/A"}
- Regime confidence: ${qualContext.regimeConfidence ?? "N/A"}
- Key themes: ${qualContext.keyThemes?.join(", ") ?? "N/A"}

Respond with JSON only:
{
  "contradictions": [
    {
      "pair": "ETH/USDC",
      "quant_says": "long",
      "qual_says": "bearish context",
      "severity": "high|medium|low",
      "recommendation": "one sentence on which signal to trust and why"
    }
  ],
  "conviction_adjustments": {
    "cbBTC/USDC": { "adjustment": -0.30 to 0.30, "rationale": "one sentence" },
    "ETH/USDC": { "adjustment": -0.30 to 0.30, "rationale": "one sentence" },
    "AERO/USDC": { "adjustment": -0.30 to 0.30, "rationale": "one sentence" }
  },
  "overall_assessment": "1-2 sentence market view"
}`;
}
