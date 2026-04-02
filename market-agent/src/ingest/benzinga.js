import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";
import { createDataPoint } from "../schema.js";
import { cacheKey, cacheSet, CACHE_TTL } from "../cache/redis.js";

// Benzinga Content API — crypto news endpoint
const BASE_URL = "https://api.benzinga.com/api/v2/news";

// Search tickers for our instrument universe
const TICKERS = ["BTC", "ETH", "AERO", "USDC"];

/**
 * Fetch recent crypto articles from Benzinga.
 */
async function fetchArticles() {
  if (!config.benzinga?.apiKey) return [];

  const start = Date.now();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data } = await axios.get(BASE_URL, {
    params: {
      token: config.benzinga.apiKey,
      channels: "crypto",
      tickers: TICKERS.join(","),
      dateFrom: oneDayAgo.split("T")[0],
      pageSize: 20,
      displayOutput: "full",
    },
    timeout: 10000,
  });

  const articles = Array.isArray(data) ? data : [];
  return articles
    .filter((a) => a.url && a.title)
    .map((a) => {
      const entities = [];
      if (a.stocks) {
        for (const stock of a.stocks) {
          if (TICKERS.includes(stock.name)) entities.push(stock.name);
        }
      }

      return createDataPoint({
        source: "news", // Normalized to same type as NewsAPI for signal engine compatibility
        pair: null,
        type: "news",
        timestamp: a.created ? new Date(a.created).getTime() : Date.now(),
        data: {
          title: a.title,
          source: "Benzinga",
          url: a.url,
          published_at: a.created,
          description: (a.teaser || "").slice(0, 500),
          sentiment: 0, // Benzinga doesn't provide sentiment — let qualitative module handle it
          relevance_score: 1.0,
          entities: entities.length > 0 ? entities : ["crypto"],
        },
        meta: { api_latency_ms: Date.now() - start, provider: "benzinga" },
      });
    });
}

/**
 * Ingest news from Benzinga.
 */
export async function ingest() {
  if (!config.benzinga?.apiKey) {
    logger.debug({ module: "benzinga" }, "BENZINGA_API_KEY not set — skipping");
    return [];
  }

  try {
    const articles = await fetchArticles();
    for (const article of articles) {
      const hash = article.data.url
        ? Buffer.from(article.data.url).toString("base64url").slice(0, 12)
        : String(Date.now());
      await cacheSet(cacheKey("news", "benzinga", hash), article, CACHE_TTL["news"]);
    }

    logger.info({ module: "benzinga", count: articles.length }, "Ingested Benzinga articles");
    return articles;
  } catch (e) {
    logger.error({ module: "benzinga", err: e.message }, "Benzinga ingestion failed");
    return [];
  }
}
