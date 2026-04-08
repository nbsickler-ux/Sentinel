// ============================================================
// STANDALONE MARKET SCANNER
// Quick scan of active Polymarket sports markets.
// Run: node src/scan.js
// ============================================================

import { getMarkets, getPrice, getOrderbook } from "./execution/polymarket.js";
import logger from "./logger.js";

async function scan() {
  console.log("\n=== POLYMARKET SPORTS MARKET SCANNER ===\n");

  const tags = ["nba", "mlb", "nhl", "ufc", "soccer"];
  const allMarkets = [];

  for (const tag of tags) {
    const markets = await getMarkets({ tag, limit: 20 });
    allMarkets.push(...markets.map((m) => ({ ...m, sport: tag })));
  }

  // Also get top general markets
  const general = await getMarkets({ limit: 50 });
  allMarkets.push(...general);

  // Deduplicate
  const seen = new Set();
  const unique = allMarkets.filter((m) => {
    const id = m.condition_id || m.id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  console.log(`Found ${unique.length} unique active markets\n`);

  // Show top 20 by volume
  const sorted = unique
    .filter((m) => m.active && m.tokens?.length >= 2)
    .sort((a, b) => (parseFloat(b.volume24hr || 0) - parseFloat(a.volume24hr || 0)));

  const top = sorted.slice(0, 25);

  for (const market of top) {
    const yesToken = market.tokens?.find((t) => t.outcome === "Yes");
    const noToken = market.tokens?.find((t) => t.outcome === "No");

    const yesPrice = market.outcomePrices ? parseFloat(market.outcomePrices[0] || 0) : null;
    const noPrice = market.outcomePrices ? parseFloat(market.outcomePrices[1] || 0) : null;

    console.log(`Market: ${market.question}`);
    console.log(`  Category: ${market.groupItemTitle || market.sport || "general"}`);
    console.log(`  YES: ${yesPrice ? (yesPrice * 100).toFixed(1) + "¢" : "?"} | NO: ${noPrice ? (noPrice * 100).toFixed(1) + "¢" : "?"}`);
    console.log(`  24h Volume: $${parseFloat(market.volume24hr || 0).toLocaleString()}`);
    console.log(`  End: ${market.endDate || market.end_date_iso || "?"}`);
    if (yesToken) console.log(`  YES token: ${yesToken.token_id?.slice(0, 16)}...`);
    console.log();
  }

  console.log(`\n=== Top ${top.length} markets by 24h volume ===`);
  console.log("Total active markets found:", sorted.length);
}

scan().catch((err) => {
  console.error("Scan failed:", err.message);
  process.exit(1);
});
