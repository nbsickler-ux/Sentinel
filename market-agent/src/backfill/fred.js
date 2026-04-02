// ============================================================
// FRED HISTORICAL BACKFILL
// Extends the existing FRED ingest pattern with wider date range.
// 120 req/min limit — more than enough for 5 series.
// ============================================================

import axios from "axios";
import config from "../config.js";
import logger from "../logger.js";

const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

// Reuse from ingest/fred.js
const INDICATORS = {
  DFF: { name: "Federal Funds Rate", unit: "percent" },
  T10Y2Y: { name: "10Y-2Y Treasury Spread", unit: "percent" },
  DTWEXBGS: { name: "Trade-Weighted USD Index", unit: "index" },
  CPIAUCSL: { name: "CPI (All Urban)", unit: "index" },
  VIXCLS: { name: "VIX", unit: "index" },
};

/**
 * Backfill all FRED series.
 *
 * @param {number} months - How many months of history
 * @returns {AsyncGenerator} Yields arrays of macro data points
 */
export async function* backfill(months = 12) {
  if (!config.fred.apiKey) {
    logger.warn({ module: "backfill:fred" }, "FRED_API_KEY not set — skipping");
    return;
  }

  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const observationStart = startDate.toISOString().split("T")[0];

  for (const [seriesId, meta] of Object.entries(INDICATORS)) {
    try {
      logger.info({
        module: "backfill:fred",
        series: seriesId,
        from: observationStart,
      }, "Fetching FRED series");

      const { data } = await axios.get(BASE_URL, {
        params: {
          series_id: seriesId,
          api_key: config.fred.apiKey,
          file_type: "json",
          sort_order: "asc",
          observation_start: observationStart,
          limit: 365,
        },
        timeout: 10000,
      });

      const observations = (data?.observations || [])
        .filter((o) => o.value !== ".")  // FRED uses "." for missing data
        .map((o) => ({
          source: "fred",
          pair: null,
          timestamp: new Date(o.date),
          series_id: seriesId,
          indicator: meta.name,
          value: parseFloat(o.value),
          unit: meta.unit,
        }));

      logger.info({
        module: "backfill:fred",
        series: seriesId,
        observations: observations.length,
      }, "FRED series fetched");

      if (observations.length > 0) {
        yield observations;
      }

      // Small delay between series
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      logger.error({
        module: "backfill:fred",
        series: seriesId,
        err: e.message,
      }, "FRED series fetch failed");
    }
  }
}
