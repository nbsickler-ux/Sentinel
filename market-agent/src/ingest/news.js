import axios from "axios";
import crypto from "crypto";
import config from "../config.js";
import logger from "../logger.js";
import { createDataPoint } from "../schema.js";
import { cacheKey, cacheSet, CACHE_TTL } from "../cache/redis.js";

const BASE_URL = "https://newsapi.org/v2/everything";

// Search queries for our instrument universe
const QUERIES = [
  { q: "cbBTC OR \"coinbase wrapped bitcoin\"", entities: ["cbBTC"] },
  { q: "Base chain OR Base L2 OR Aerodrome", entities: ["AERO", "Base"] },
  { q: "Bitcoin crypto regulation SEC", entities: ["BTC", "cbBTC"] },
  { q: "Ethereum ETH DeFi", entities: ["ETH"] },
  { q: "stablecoin USDC Circle", entities: ["USDC"] },
];

/**
 * Generate a short hash of a URL for cache key uniqueness.
 */
function urlHash(url) {
  return crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
}

/**
 * Basic sentiment scoring from title/description text.
 * Phase 2 will replace this with Claude-based qualitative analysis.
 */
function simpleSentiment(text) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  const bullish = ["surge", "rally", "gain", "bullish", "soar", "record", "adoption", "approval", "partnership"];
  const bearish = ["crash", "plunge", "drop", "bearish", "hack", "exploit", "sec", "lawsuit", "ban", "fraud"];

  let score = 0;
  for (const word of bullish) if (lower.includes(word)) score += 0.2;
  for (const word of bearish) if (lower.includes(word)) score -= 0.2;
  return Math.max(-1, Math.min(1, score));
}

/**
 * Fetch news articles matching a query.
 */
async function fetchArticles(queryObj) {
  const start = Date.now();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data } = await axios.get(BASE_URL, {
    params: {
      q: queryObj.q,
      from: oneDayAgo,
      sortBy: "publishedAt",
      language: "en",
      pageSize: 10,
      apiKey: config.news.apiKey,
    },
    timeout: 10000,
  });

  const articles = data?.articles || [];
  return articles
    .filter((a) => a.url && a.title !== "[Removed]")
    .map((a) => {
      const text = `${a.title || ""} ${a.description || ""}`;
      return createDataPoint({
        source: "news",
        pair: null,
        type: "news",
        timestamp: a.publishedAt ? new Date(a.publishedAt).getTime() : Date.now(),
        data: {
          title: a.title,
          source: a.source?.name || "unknown",
          url: a.url,
          published_at: a.publishedAt,
          description: (a.description || "").slice(0, 500),
          sentiment: simpleSentiment(text),
          relevance_score: 1.0, // All matched query, so baseline relevant
          entities: queryObj.entities,
        },
        meta: { api_latency_ms: Date.now() - start },
      });
    });
}

/**
 * Ingest news for all queries.
 */
export async function ingest() {
  if (!config.news.apiKey) {
    logger.warn({ module: "news" }, "NEWS_API_KEY not set — skipping");
    return [];
  }

  const results = [];
  const seenUrls = new Set();

  for (const queryObj of QUERIES) {
    try {
      const articles = await fetchArticles(queryObj);
      for (const article of articles) {
        // Deduplicate across queries
        if (seenUrls.has(article.data.url)) continue;
        seenUrls.add(article.data.url);

        const hash = urlHash(article.data.url);
        await cacheSet(cacheKey("news", "newsapi", hash), article, CACHE_TTL["news"]);
        results.push(article);
      }
      logger.info({
        module: "news",
        query: queryObj.q.slice(0, 40),
        count: articles.length,
      }, "Ingested news articles");
    } catch (e) {
      logger.error({ module: "news", query: queryObj.q.slice(0, 40), err: e.message }, "Ingestion failed");
    }
  }

  logger.info({ module: "news", total: results.length }, "News ingestion complete");
  return results;
}
