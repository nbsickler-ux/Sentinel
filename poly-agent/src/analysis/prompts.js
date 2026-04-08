// ============================================================
// PREDICTION MARKET PROMPTS
// Prompt templates for Claude analysis of prediction markets.
// Version: 1.0
// ============================================================

export const PROMPT_VERSION = "1.0";

// ── SYSTEM PROMPTS ──

export const FAIR_VALUE_SYSTEM = `You are a calibrated sports prediction analyst covering ALL sports globally. Your job is to estimate the true probability of outcomes in prediction markets.

CALIBRATION IS EVERYTHING. When you say 60%, the event should happen ~60% of the time. The most common failure mode is overconfidence — pulling probabilities too far from 50%.

Sport-specific knowledge:
- NBA/NHL: Home court +3-5%. Back-to-back fatigue matters. Injury status: "Questionable" plays ~65% of the time.
- MLB: Home field +2-3%. Starting pitcher is the dominant factor. Weather affects totals.
- Soccer (EPL, La Liga, Bundesliga, Champions League, World Cup): Home advantage +5-10% in domestic leagues, less in tournaments. Draw probability is typically 25-30%. Red cards shift win probability ~15-20%.
- F1: Qualifying position is the strongest predictor. Track-specific advantages are real (Monaco favors pole, Monza favors engine). Weather changes everything.
- Golf: Field size makes any individual winning unlikely. Favorites rarely exceed 15-20% to win an event. Course fit and recent form matter. Cut probability is a useful market.
- Tennis: Surface matters enormously (clay/hard/grass). Head-to-head records are more predictive than rankings. Fatigue in majors (5 sets vs 3).
- Esports (LoL, Dota 2, etc.): Patch changes shift power. Map/draft phase is critical. Regional strength varies. Bo1 vs Bo3 volatility differs hugely.
- UFC/MMA: Stylistic matchups matter more than records. Weight class changes affect performance. Short-notice replacements underperform.
- Cricket: Toss + conditions dominate. Pitch deterioration in Tests. Dew factor in T20s.

General rules:
- Base rates matter more than narratives. Start from historical base rates and adjust.
- Futures markets (season-long): favorites are typically overpriced. Long shots have value.
- Multi-outcome markets (tournament winners): ensure your probabilities sum to ~100%.
- When genuinely uncertain, pull toward the base rate. Being wrong at 50% costs less than being wrong at 80%.

Output ONLY valid JSON. No explanation outside the JSON.`;

export const OVERREACTION_SYSTEM = `You are a prediction market analyst specializing in detecting overreactions to breaking news across ALL sports globally.

Markets frequently move too far, too fast on news before settling back. Your job is to identify these overreactions within minutes of the move happening.

Key overreaction patterns by sport:
- NBA/NFL: "Star player questionable" causes 10-15¢ drops but player usually plays → fade
- Soccer: Manager sacking rumors move futures hard, but successors often maintain form
- F1: Rain forecasts cause massive swings in race winner odds, often overcorrected
- Golf: Early round leaders get overpriced — regression to the mean is extreme in 72-hole events
- Tennis: First set loss by favorite causes panic selling, but top players frequently reverse
- Esports: Patch notes/roster leaks cause premature moves before impact is known
- UFC: Last-minute opponent changes create chaos — replacement fighters are systematically undervalued
- Cricket: Toss result moves odds too far — pitch conditions matter more than toss advantage

General patterns:
- Injury reports with vague language ("day-to-day") are less severe than specific ("torn ACL")
- Weather reports cause outsized moves in outdoor sports
- Breaking news moves the most liquid market first; related markets lag
- Public sentiment (social media buzz) causes overreaction in popular markets

Output ONLY valid JSON. No explanation outside the JSON.`;

export const CORRELATION_SYSTEM = `You are a prediction market analyst specializing in cross-market correlations.

When a single event (injury, trade, weather) affects one market, it often creates cascading mispricings in related markets. Your job is to identify ALL markets affected by a single piece of news.

Example: If a star NBA player is ruled out, it affects:
1. That game's spread/moneyline
2. That game's over/under total
3. The opposing team's next game odds
4. Series/playoff advancement odds
5. MVP/award futures
6. Division/conference winner odds

Output ONLY valid JSON. No explanation outside the JSON.`;

// ── USER PROMPTS ──

/**
 * Fair value estimation prompt.
 * Takes market context + news and produces a probability estimate.
 */
export function fairValuePrompt({ market, currentOdds, news, injuries, scoreboard, historicalContext }) {
  const newsBlock = news.length > 0
    ? news.map((n) => `- [${n.source}] ${n.title}`).join("\n")
    : "No relevant news in last 24h.";

  const injuryBlock = injuries.length > 0
    ? injuries.map((i) => `- ${i.player} (${i.team}): ${i.status} — ${i.detail || i.type}`).join("\n")
    : "No relevant injury updates.";

  const scoreBlock = scoreboard
    ? `Game status: ${scoreboard.status || "scheduled"}\nTeams: ${scoreboard.teams?.map((t) => `${t.name} (${t.homeAway})`).join(" vs ")}\nVegas line: ${scoreboard.teams?.[0]?.odds || "N/A"}`
    : "No game data available.";

  return `Estimate the fair probability for this prediction market:

MARKET: ${market.question}
CURRENT ODDS: Yes ${(currentOdds.yes * 100).toFixed(1)}¢ / No ${(currentOdds.no * 100).toFixed(1)}¢
RESOLUTION: ${market.endDate || "Unknown"}
CATEGORY: ${market.category || "sports"}

RELEVANT NEWS (last 24h):
${newsBlock}

INJURY REPORT:
${injuryBlock}

GAME CONTEXT:
${scoreBlock}

${historicalContext ? `HISTORICAL CONTEXT:\n${historicalContext}` : ""}

Respond with ONLY this JSON:
{
  "fair_probability": <0.0 to 1.0>,
  "confidence": <0.0 to 1.0>,
  "edge_vs_market": <our estimate minus market price, in cents>,
  "direction": "buy_yes" | "buy_no" | "no_trade",
  "key_factors": ["<factor1>", "<factor2>", "<factor3>"],
  "news_impact": "positive" | "negative" | "neutral" | "mixed",
  "base_rate": <historical base rate if known, else null>,
  "adjustment_from_base": <how much we adjusted from base rate and why>,
  "rationale": "<2-3 sentences>"
}`;
}

/**
 * Overreaction detection prompt.
 * Triggered when a market moves significantly in a short window.
 */
export function overreactionPrompt({ market, priceBefore, priceNow, minutesSinceMove, newsContent }) {
  const delta = ((priceNow - priceBefore) * 100).toFixed(1);

  return `A prediction market just moved significantly:

MARKET: ${market.question}
PRICE BEFORE: ${(priceBefore * 100).toFixed(1)}¢
PRICE NOW: ${(priceNow * 100).toFixed(1)}¢
MOVE: ${delta}¢ in ${minutesSinceMove} minutes

THE NEWS CAUSING THE MOVE:
${newsContent || "Unknown — price moved without clear catalyst."}

Is this move justified or an overreaction?

Respond with ONLY this JSON:
{
  "assessment": "justified" | "overreaction" | "underreaction",
  "fair_price_estimate": <0 to 100 in cents>,
  "reversion_expected": <true/false>,
  "reversion_magnitude_cents": <0 to 50>,
  "time_to_reversion": "minutes" | "hours" | "days",
  "confidence": <0.0 to 1.0>,
  "rationale": "<2-3 sentences>"
}`;
}

/**
 * Cross-market correlation prompt.
 * Identifies all markets affected by a single news event.
 */
export function correlationPrompt({ newsEvent, activeMarkets }) {
  const marketList = activeMarkets
    .map((m) => `- [${m.conditionId?.slice(0, 8)}] ${m.question} (Yes: ${(m.yesPrice * 100).toFixed(0)}¢)`)
    .join("\n");

  return `A news event just broke. Identify ALL prediction markets that should be affected:

NEWS EVENT:
${newsEvent.title}
${newsEvent.description || ""}
${newsEvent.detail || ""}

ACTIVE MARKETS:
${marketList}

For each affected market, estimate the direction and magnitude of the expected price impact.

Respond with ONLY this JSON:
{
  "affected_markets": [
    {
      "condition_id": "<first 8 chars>",
      "question": "<market question>",
      "impact_direction": "yes_up" | "yes_down" | "uncertain",
      "expected_move_cents": <1 to 30>,
      "confidence": <0.0 to 1.0>,
      "reasoning": "<1 sentence>"
    }
  ],
  "cascade_type": "injury" | "trade" | "weather" | "lineup" | "breaking_news" | "other",
  "urgency": "immediate" | "minutes" | "hours"
}`;
}

/**
 * News relevance scoring prompt.
 * Quick filter: does this news item affect any of our watched markets?
 */
export function newsRelevancePrompt({ newsItem, watchedMarkets }) {
  const marketList = watchedMarkets
    .map((m) => `- ${m.question}`)
    .join("\n");

  return `Does this news affect any of these prediction markets?

NEWS: ${newsItem.title}
${newsItem.description || ""}

MARKETS:
${marketList}

Respond with ONLY this JSON:
{
  "relevant": <true/false>,
  "affected_markets": ["<question1>", "<question2>"],
  "impact_magnitude": "high" | "medium" | "low" | "none",
  "summary": "<1 sentence>"
}`;
}
