// ============================================================
// UNIFIED DATA SCHEMA
// All ingestion modules normalize output to DataPoint
// ============================================================

const VALID_SOURCES = ["aerodrome", "alchemy", "coinbase", "coingecko", "fred", "news"];
const VALID_TYPES = ["price", "pool", "onchain", "macro", "news", "orderbook"];

/**
 * Create a validated DataPoint.
 *
 * @param {Object} params
 * @param {string} params.source   - One of VALID_SOURCES
 * @param {string|null} params.pair - Trading pair or null for macro/news
 * @param {string} params.type     - One of VALID_TYPES
 * @param {number} params.timestamp - Unix ms when data was observed
 * @param {Object} params.data     - Source-specific payload
 * @param {Object} [params.meta]   - Optional metadata overrides
 * @returns {Object} Validated DataPoint
 */
export function createDataPoint({ source, pair, type, timestamp, data, meta = {} }) {
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`Invalid source: ${source}. Must be one of: ${VALID_SOURCES.join(", ")}`);
  }
  if (!VALID_TYPES.includes(type)) {
    throw new Error(`Invalid type: ${type}. Must be one of: ${VALID_TYPES.join(", ")}`);
  }
  if (!timestamp || typeof timestamp !== "number") {
    throw new Error("timestamp must be a Unix ms number");
  }
  if (!data || typeof data !== "object") {
    throw new Error("data must be a non-null object");
  }

  return {
    source,
    pair: pair || null,
    type,
    timestamp,
    ingested_at: Date.now(),
    data,
    meta: {
      cache_hit: false,
      version: "1.0.0",
      ...meta,
    },
  };
}

export { VALID_SOURCES, VALID_TYPES };
