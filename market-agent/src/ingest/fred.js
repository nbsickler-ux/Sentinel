import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";
import { createDataPoint } from "../schema.js";
import { cacheKey, cacheSet, CACHE_TTL } from "../cache/redis.js";

const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

// Macro indicators relevant to crypto/DeFi markets
const INDICATORS = {
  DFF:      { name: "Federal Funds Rate", unit: "percent" },
  T10Y2Y:   { name: "10Y-2Y Treasury Spread", unit: "percent" },
  DTWEXBGS: { name: "Trade-Weighted USD Index", unit: "index" },
  CPIAUCSL: { name: "CPI (All Urban)", unit: "index" },
  VIXCLS:   { name: "VIX", unit: "index" },
};

/**
 * Fetch latest observation for a FRED series.
 */
async function fetchSeries(seriesId) {
  const start = Date.now();
  const { data } = await axios.get(BASE_URL, {
    params: {
      series_id: seriesId,
      api_key: config.fred.apiKey,
      file_type: "json",
      sort_order: "desc",
      limit: 2, // Latest + previous for delta calc
    },
    timeout: 10000,
  });

  const observations = data?.observations || [];
  if (observations.length === 0) {
    throw new Error(`No observations for ${seriesId}`);
  }

  const latest = observations[0];
  const previous = observations.length > 1 ? observations[1] : null;
  const indicator = INDICATORS[seriesId] || { name: seriesId, unit: "unknown" };

  return createDataPoint({
    source: "fred",
    pair: null,
    type: "macro",
    timestamp: new Date(latest.date).getTime(),
    data: {
      series_id: seriesId,
      indicator: indicator.name,
      value: parseFloat(latest.value) || 0,
      previous: previous ? parseFloat(previous.value) || 0 : null,
      delta: previous
        ? (parseFloat(latest.value) || 0) - (parseFloat(previous.value) || 0)
        : null,
      unit: indicator.unit,
      release_date: latest.date,
    },
    meta: { api_latency_ms: Date.now() - start },
  });
}

/**
 * Ingest all FRED macro indicators.
 */
export async function ingest() {
  if (!config.fred.apiKey) {
    logger.warn({ module: "fred" }, "FRED_API_KEY not set — skipping");
    return [];
  }

  const results = [];
  for (const seriesId of Object.keys(INDICATORS)) {
    try {
      const point = await fetchSeries(seriesId);
      await cacheSet(cacheKey("macro", "fred", seriesId), point, CACHE_TTL["macro:fred"]);
      results.push(point);
      logger.info({
        module: "fred",
        series: seriesId,
        value: point.data.value,
      }, "Ingested macro data");
    } catch (e) {
      logger.error({ module: "fred", series: seriesId, err: e.message }, "Ingestion failed");
    }
  }
  return results;
}
