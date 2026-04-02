// ============================================================
// CLAUDE API CONTEXT MODULE
// Processes unstructured data through Claude for qualitative analysis.
// Model: claude-sonnet-4-20250514, 1000 max_tokens per call.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import config from "../config.js";
import logger from "../logger.js";
import { cacheGet } from "../cache/redis.js";
import { saveApiCost } from "../db/queries.js";
import { SYSTEM_PROMPT, PROMPT_VERSION, newsSynthesisPrompt, macroAnalysisPrompt, contradictionPrompt } from "./prompts.js";

// ── API PRICING (per million tokens) ──
// Updated for current Anthropic pricing. Adjust when models/pricing change.
const MODEL_PRICING = {
  "claude-sonnet-4-20250514":   { input: 3.00, output: 15.00 },
  "claude-haiku-4-5-20251001":  { input: 0.80, output: 4.00 },
};

/**
 * Compute USD cost from token usage and model.
 */
function computeCost(model, tokensIn, tokensOut) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["claude-sonnet-4-20250514"];
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

// Module-level cycle tracker — set by analyze() each cycle
let currentCycle = null;

let client = null;

if (config.anthropic.apiKey) {
  client = new Anthropic({ apiKey: config.anthropic.apiKey });
  logger.info({ module: "qualitative" }, "Claude API client initialized");
} else {
  logger.warn({ module: "qualitative" }, "ANTHROPIC_API_KEY not set — qualitative module disabled");
}

/**
 * Validate that a parsed JSON object contains the required keys.
 * Returns true if valid, logs warning and returns false otherwise.
 */
function validateSchema(parsed, requiredKeys, context) {
  const missing = requiredKeys.filter((k) => !(k in parsed));
  if (missing.length > 0) {
    logger.warn({
      module: "qualitative",
      context,
      missing_keys: missing,
    }, "Claude output missing required fields");
    return false;
  }
  return true;
}

// Required keys per prompt type
const SCHEMA_KEYS = {
  news: ["articles", "overall_sentiment", "regime_signal", "key_themes"],
  macro: ["regime", "regime_confidence", "regime_rationale", "pair_impacts", "key_risks"],
  contradiction: ["contradictions", "conviction_adjustments", "overall_assessment"],
};

// Per-prompt model routing: Haiku for structured extraction, Sonnet for reasoning
const PROMPT_MODELS = {
  news: config.qualitative.models.news_synthesis,
  macro: config.qualitative.models.macro_analysis,
  contradiction: config.qualitative.models.contradiction,
};

/**
 * Call Claude API with structured JSON output.
 * @param {string} userPrompt - The user prompt to send
 * @param {string} [schemaType] - Optional schema type for validation ('news', 'macro', 'contradiction')
 */
async function callClaude(userPrompt, schemaType) {
  if (!client) return null;

  const model = PROMPT_MODELS[schemaType] || config.anthropic.model;
  const start = Date.now();
  try {
    const response = await client.messages.create({
      model,
      max_tokens: config.anthropic.maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    });

    const text = response.content[0]?.text || "";
    const latency = Date.now() - start;

    // Parse JSON from response (Claude may wrap in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ module: "qualitative", latency_ms: latency }, "No JSON found in Claude response");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate output schema if type is specified
    if (schemaType && SCHEMA_KEYS[schemaType]) {
      if (!validateSchema(parsed, SCHEMA_KEYS[schemaType], schemaType)) {
        logger.warn({ module: "qualitative", schemaType }, "Schema validation failed — returning raw parsed output anyway");
      }
    }

    const tokensIn = response.usage?.input_tokens || 0;
    const tokensOut = response.usage?.output_tokens || 0;
    const costUsd = computeCost(model, tokensIn, tokensOut);

    logger.info({
      module: "qualitative",
      model,
      latency_ms: latency,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd.toFixed(6),
      schemaType,
      prompt_version: PROMPT_VERSION,
    }, "Claude API call complete");

    // Persist cost record (non-blocking)
    saveApiCost(currentCycle, {
      promptType: schemaType || "unknown",
      model,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs: latency,
      promptVersion: PROMPT_VERSION,
    }).catch((e) => {
      logger.debug({ module: "qualitative", err: e.message }, "API cost persistence failed");
    });

    return { data: parsed, latency_ms: latency, usage: response.usage, cost_usd: costUsd };
  } catch (e) {
    logger.error({ module: "qualitative", err: e.message, latency_ms: Date.now() - start }, "Claude API call failed");
    return null;
  }
}

/**
 * Gather cached news articles for synthesis.
 */
async function gatherNews() {
  // News articles are cached with hash-based keys, so we scan for recent ones
  // For now, we collect from the latest ingestion results passed in
  return [];
}

/**
 * Gather cached macro indicators.
 */
async function gatherMacro() {
  const seriesIds = ["DFF", "T10Y2Y", "DTWEXBGS", "CPIAUCSL", "VIXCLS"];
  const indicators = [];

  for (const id of seriesIds) {
    const data = await cacheGet(`ma:macro:fred:${id}`);
    if (data?.data) {
      indicators.push(data.data);
    }
  }

  return indicators;
}

/**
 * Run full qualitative analysis cycle.
 *
 * @param {Object[]} newsDataPoints - News DataPoints from latest ingestion
 * @param {Object[]} quantSignals - Signal objects from quant engine
 * @returns {Object} Qualitative context: news synthesis, macro regime, contradictions, adjustments
 */
export async function analyze(newsDataPoints = [], quantSignals = [], cycle = null) {
  currentCycle = cycle;

  if (!client) {
    logger.warn({ module: "qualitative" }, "Skipping — no API key");
    return {
      available: false,
      newsSynthesis: null,
      macroAnalysis: null,
      contradictions: null,
      timestamp: Date.now(),
    };
  }

  const result = {
    available: true,
    newsSynthesis: null,
    macroAnalysis: null,
    contradictions: null,
    timestamp: Date.now(),
  };

  // 1. News synthesis
  const articles = newsDataPoints
    .filter((dp) => dp.type === "news")
    .map((dp) => dp.data);

  if (articles.length > 0) {
    const newsResult = await callClaude(newsSynthesisPrompt(articles), "news");
    if (newsResult) {
      result.newsSynthesis = newsResult.data;
      result.newsLatency = newsResult.latency_ms;
    }
  } else {
    logger.debug({ module: "qualitative" }, "No news articles to analyze");
  }

  // 2. Macro analysis
  const indicators = await gatherMacro();
  if (indicators.length > 0) {
    const macroResult = await callClaude(macroAnalysisPrompt(indicators), "macro");
    if (macroResult) {
      result.macroAnalysis = macroResult.data;
      result.macroLatency = macroResult.latency_ms;
    }
  } else {
    logger.debug({ module: "qualitative" }, "No macro data to analyze");
  }

  // 3. Contradiction detection (needs both quant signals and qual context)
  if (quantSignals.length > 0 && (result.newsSynthesis || result.macroAnalysis)) {
    const qualContext = {
      newsSentiment: result.newsSynthesis?.overall_sentiment,
      macroRegime: result.macroAnalysis?.regime,
      regimeConfidence: result.macroAnalysis?.regime_confidence,
      keyThemes: [
        ...(result.newsSynthesis?.key_themes || []),
        ...(result.macroAnalysis?.key_risks || []),
      ],
    };

    const contradictionResult = await callClaude(contradictionPrompt(quantSignals, qualContext), "contradiction");
    if (contradictionResult) {
      result.contradictions = contradictionResult.data;
      result.contradictionLatency = contradictionResult.latency_ms;
    }
  }

  logger.info({
    module: "qualitative",
    hasNews: !!result.newsSynthesis,
    hasMacro: !!result.macroAnalysis,
    hasContradictions: !!result.contradictions,
  }, "Qualitative analysis complete");

  return result;
}
