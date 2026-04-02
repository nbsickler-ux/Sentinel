import logger from "../logger.js";
import * as coinbase from "./coinbase.js";
import * as aerodrome from "./aerodrome.js";
import * as alchemy from "./alchemy.js";
import * as coingecko from "./coingecko.js";
import * as fred from "./fred.js";
import * as news from "./news.js";
import * as benzinga from "./benzinga.js";

const modules = [
  { name: "coinbase",  module: coinbase },
  { name: "aerodrome", module: aerodrome },
  { name: "alchemy",   module: alchemy },
  { name: "coingecko", module: coingecko },
  { name: "fred",      module: fred },
  { name: "news",      module: news },
  { name: "benzinga",  module: benzinga },
];

/**
 * Run all ingestion modules. Returns summary of results.
 */
export async function runAll() {
  const summary = { total: 0, bySource: {}, errors: [], startedAt: Date.now() };

  const results = await Promise.allSettled(
    modules.map(async ({ name, module }) => {
      const start = Date.now();
      try {
        const points = await module.ingest();
        const count = points.length;
        summary.bySource[name] = { count, latency_ms: Date.now() - start, status: "ok" };
        return points;
      } catch (e) {
        summary.bySource[name] = { count: 0, latency_ms: Date.now() - start, status: "error", error: e.message };
        summary.errors.push({ source: name, error: e.message });
        return [];
      }
    })
  );

  const allPoints = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  summary.total = allPoints.length;
  summary.duration_ms = Date.now() - summary.startedAt;

  logger.info({
    module: "orchestrator",
    total: summary.total,
    duration_ms: summary.duration_ms,
    sources: Object.fromEntries(
      Object.entries(summary.bySource).map(([k, v]) => [k, `${v.count} (${v.status})`])
    ),
  }, "Ingestion cycle complete");

  return { points: allPoints, summary };
}

export { modules };
