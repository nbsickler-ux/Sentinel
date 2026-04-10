#!/usr/bin/env node
// ============================================================
// DRY RUN: Validate weather data pipeline + edge math
// Fetches real Open-Meteo data, simulates Kalshi brackets,
// computes edges — all without touching Kalshi API.
//
// Usage: node src/dry-run.js
// ============================================================

import {
  CITIES,
  fetchEnsembleForecast,
  fetchAllForecasts,
  computeBracketProbabilities,
  parseBracketFromTitle,
  getTomorrowDateET,
  getTodayDateET,
} from "./execution/weather.js";
import { findWeatherEdges, kalshiFee, summarizeEdges } from "./analysis/edge.js";

console.log("=== WEATHER BOT DRY RUN ===\n");

const today = getTodayDateET();
const tomorrow = getTomorrowDateET();
console.log(`Today (ET):    ${today}`);
console.log(`Tomorrow (ET): ${tomorrow}\n`);

// ── STEP 1: Fetch ensemble forecasts ──
console.log("── STEP 1: Fetching ensemble forecasts from Open-Meteo ──\n");

const forecasts = await fetchAllForecasts(tomorrow);

let allGood = true;
for (const [code, city] of Object.entries(CITIES)) {
  const f = forecasts[code];
  if (!f || f.members.length === 0) {
    console.log(`  ❌ ${city.name} (${code}): NO DATA`);
    allGood = false;
    continue;
  }
  const min = Math.min(...f.members).toFixed(1);
  const max = Math.max(...f.members).toFixed(1);
  const mean = (f.members.reduce((a, b) => a + b, 0) / f.members.length).toFixed(1);
  const std = Math.sqrt(f.members.reduce((s, t) => s + (t - mean) ** 2, 0) / f.members.length).toFixed(1);
  console.log(`  ✓ ${city.name} (${code}): ${f.members.length} members | ${min}°F – ${max}°F | mean ${mean}°F | std ${std}°F`);
}
console.log();

if (!allGood) {
  console.log("⚠️  Some cities had no data. The API may not return data for all models.\n");
}

// ── STEP 2: Test bracket parsing ──
console.log("── STEP 2: Testing bracket parser ──\n");

const testTitles = [
  "79°F or below",
  "80°F to 81°F",
  "82°F to 83°F",
  "84°F to 85°F",
  "86°F to 87°F",
  "88°F or above",
  "Below 65°F",
  "Above 90",
  "72 - 73",
  "≥ 85°F",
];

for (const title of testTitles) {
  const bracket = parseBracketFromTitle(title);
  const lowStr = bracket?.low != null ? `${bracket.low}°F` : "-∞";
  const highStr = bracket?.high != null ? `${bracket.high}°F` : "+∞";
  console.log(`  "${title}" → [${lowStr}, ${highStr})`);
}
console.log();

// ── STEP 3: Compute bracket probabilities for NYC ──
console.log("── STEP 3: Bracket probabilities (NYC example) ──\n");

const nycForecast = forecasts.NYC;
if (nycForecast && nycForecast.members.length > 0) {
  // Generate realistic brackets based on the forecast mean
  const mean = nycForecast.members.reduce((a, b) => a + b, 0) / nycForecast.members.length;
  const center = Math.round(mean);

  const brackets = [
    { ticker: "BELOW", low: null, high: center - 3 },
    { ticker: "BRK1", low: center - 3, high: center - 1 },
    { ticker: "BRK2", low: center - 1, high: center + 1 },
    { ticker: "BRK3", low: center + 1, high: center + 3 },
    { ticker: "BRK4", low: center + 3, high: center + 5 },
    { ticker: "ABOVE", low: center + 5, high: null },
  ];

  const probs = computeBracketProbabilities(nycForecast.members, brackets);
  let sumProb = 0;
  for (const p of probs) {
    const lowStr = p.low != null ? `${p.low}°F` : "-∞";
    const highStr = p.high != null ? `${p.high}°F` : "+∞";
    console.log(`  [${lowStr}, ${highStr})  →  ${(p.probability * 100).toFixed(1)}% (${p.memberCount}/${nycForecast.members.length} members)`);
    sumProb += p.probability;
  }
  console.log(`  Sum of probabilities: ${(sumProb * 100).toFixed(1)}% (should be 100%)\n`);
} else {
  console.log("  ⚠️ No NYC data — skipping bracket example\n");
}

// ── STEP 4: Fee schedule ──
console.log("── STEP 4: Kalshi fee schedule ──\n");

const testPrices = [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95];
for (const p of testPrices) {
  const fee = kalshiFee(p);
  console.log(`  Price ${(p * 100).toFixed(0)}¢ → Fee ${(fee * 100).toFixed(2)}¢`);
}
console.log();

// ── STEP 5: Simulate edge detection with fake Kalshi prices ──
console.log("── STEP 5: Simulated edge detection ──\n");

if (nycForecast && nycForecast.members.length > 0) {
  const mean = nycForecast.members.reduce((a, b) => a + b, 0) / nycForecast.members.length;
  const center = Math.round(mean);

  // Simulate Kalshi markets with deliberately mispriced brackets
  const fakeMarkets = [
    { ticker: "SIM-BELOW", cityCode: "NYC", cityName: "New York City", bracket: { low: null, high: center - 3 }, bracketLabel: `Below ${center - 3}°F`, yesPrice: 0.15, volume: 100, closeTime: null },
    { ticker: "SIM-BRK1", cityCode: "NYC", cityName: "New York City", bracket: { low: center - 3, high: center - 1 }, bracketLabel: `${center - 3}°F to ${center - 2}°F`, yesPrice: 0.20, volume: 100, closeTime: null },
    { ticker: "SIM-BRK2", cityCode: "NYC", cityName: "New York City", bracket: { low: center - 1, high: center + 1 }, bracketLabel: `${center - 1}°F to ${center}°F`, yesPrice: 0.25, volume: 100, closeTime: null },
    { ticker: "SIM-BRK3", cityCode: "NYC", cityName: "New York City", bracket: { low: center + 1, high: center + 3 }, bracketLabel: `${center + 1}°F to ${center + 2}°F`, yesPrice: 0.20, volume: 100, closeTime: null },
    { ticker: "SIM-BRK4", cityCode: "NYC", cityName: "New York City", bracket: { low: center + 3, high: center + 5 }, bracketLabel: `${center + 3}°F to ${center + 4}°F`, yesPrice: 0.12, volume: 100, closeTime: null },
    { ticker: "SIM-ABOVE", cityCode: "NYC", cityName: "New York City", bracket: { low: center + 5, high: null }, bracketLabel: `Above ${center + 5}°F`, yesPrice: 0.08, volume: 100, closeTime: null },
  ];

  const edges = findWeatherEdges(fakeMarkets, forecasts, {
    minEdgeCents: 1,
    tradeEdgeCents: 5,
    minVolume: 0,
    minMembers: 5,
  });

  if (edges.length > 0) {
    for (const e of edges) {
      const emoji = e.tradeEligible ? "🟢" : "🟡";
      console.log(`  ${emoji} ${e.ticker}: ${e.side} | model=${(e.modelProb * 100).toFixed(1)}% vs market=${(e.marketPrice * 100).toFixed(1)}% | raw=${e.rawEdgeCents}¢ fee=${e.feeCents}¢ net=${e.netEdgeCents}¢ | EV=$${e.evPerContract.toFixed(4)}`);
    }

    console.log();
    const summary = summarizeEdges(edges);
    console.log("  Summary:", JSON.stringify(summary, null, 2));
  } else {
    console.log("  No edges found — simulated prices happened to be close to model probs");
    console.log("  (This is normal — the simulation uses arbitrary prices)");
  }
} else {
  console.log("  ⚠️ No NYC data — skipping edge simulation\n");
}

console.log("\n=== DRY RUN COMPLETE ===");
console.log("If you see ensemble data above, the Open-Meteo pipeline works.");
console.log("Next: connect to Kalshi API and run against real market prices.");
