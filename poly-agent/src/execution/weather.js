// ============================================================
// WEATHER DATA PIPELINE
// Fetches ensemble forecast data from Open-Meteo (free, no API key)
// and computes bracket probabilities for Kalshi temperature markets.
//
// Data sources:
//   - GEFS (GFS Seamless): 31 ensemble members
//   - ECMWF IFS: 51 ensemble members
//   Combined = up to 82 independent temperature forecasts
//
// For each city/day, we get every ensemble member's predicted high,
// then count how many fall in each Kalshi bracket → probability.
// ============================================================

import axios from "axios";
import logger from "../logger.js";

// ── KALSHI WEATHER MARKET CONFIGURATION ──

export const CITIES = {
  NYC: {
    name: "New York City",
    station: "Central Park",
    lat: 40.7828,
    lon: -73.9653,
    seriesTicker: "KXHIGHNY",
  },
  CHI: {
    name: "Chicago",
    station: "O'Hare",
    lat: 41.9742,
    lon: -87.9073,
    seriesTicker: "KXHIGHCHI",
  },
  MIA: {
    name: "Miami",
    station: "Miami Intl",
    lat: 25.7617,
    lon: -80.1918,
    seriesTicker: "KXHIGHMIA",
  },
  LAX: {
    name: "Los Angeles",
    station: "Downtown LA",
    lat: 34.0522,
    lon: -118.2437,
    seriesTicker: "KXHIGHLAX",
  },
  DEN: {
    name: "Denver",
    station: "Denver Intl",
    lat: 39.8561,
    lon: -104.6737,
    seriesTicker: "KXHIGHDEN",
  },
};

const OPEN_METEO_ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";

// ── FETCH ENSEMBLE FORECAST ──

/**
 * Fetch ensemble temperature forecasts for a city.
 * Returns an array of daily high temperatures — one per ensemble member.
 *
 * @param {Object} city - City config from CITIES
 * @param {string} targetDate - ISO date string (YYYY-MM-DD) for the forecast day
 * @returns {Object} { members: number[], modelInfo: { gefs: number, ecmwf: number } }
 */
export async function fetchEnsembleForecast(city, targetDate) {
  try {
    const resp = await axios.get(OPEN_METEO_ENSEMBLE_URL, {
      params: {
        latitude: city.lat,
        longitude: city.lon,
        daily: "temperature_2m_max",
        models: "gfs_seamless,ecmwf_ifs025",
        forecast_days: 3,
        temperature_unit: "fahrenheit",
      },
      timeout: 15_000,
    });

    const data = resp.data;
    const allMembers = [];
    let gefsCount = 0;
    let ecmwfCount = 0;

    // Open-Meteo returns separate arrays per model when using daily aggregates
    // Each model key has: daily.temperature_2m_max with shape [days][members]
    // OR it may flatten into a single array depending on the endpoint version

    // The ensemble API returns data keyed by model
    // Format: data[model].daily.temperature_2m_max = [[day1_members], [day2_members], ...]
    // OR with daily aggregates it may use: daily.temperature_2m_max_member01, etc.

    // Strategy: parse all ensemble member columns from the response
    const models = ["gfs_seamless", "ecmwf_ifs025"];

    for (const model of models) {
      const modelData = data[model] || data;
      if (!modelData?.daily) continue;

      const daily = modelData.daily;
      const dates = daily.time || [];
      const dateIdx = dates.indexOf(targetDate);

      if (dateIdx === -1) {
        logger.debug({ module: "weather", city: city.name, targetDate, availableDates: dates }, "Target date not in forecast range");
        continue;
      }

      // Ensemble members come as temperature_2m_max_member01, member02, etc.
      for (const key of Object.keys(daily)) {
        if (!key.startsWith("temperature_2m_max_member")) continue;
        const val = daily[key]?.[dateIdx];
        if (val != null && !isNaN(val)) {
          allMembers.push(val);
          if (model === "gfs_seamless") gefsCount++;
          else ecmwfCount++;
        }
      }
    }

    // Fallback: if the API returns a flat structure (single model block)
    if (allMembers.length === 0 && data?.daily) {
      const daily = data.daily;
      const dates = daily.time || [];
      const dateIdx = dates.indexOf(targetDate);

      if (dateIdx >= 0) {
        for (const key of Object.keys(daily)) {
          if (!key.startsWith("temperature_2m_max_member")) continue;
          const val = daily[key]?.[dateIdx];
          if (val != null && !isNaN(val)) {
            allMembers.push(val);
          }
        }
      }
    }

    logger.info({
      module: "weather",
      city: city.name,
      targetDate,
      totalMembers: allMembers.length,
      gefs: gefsCount,
      ecmwf: ecmwfCount,
      min: allMembers.length > 0 ? Math.min(...allMembers).toFixed(1) : null,
      max: allMembers.length > 0 ? Math.max(...allMembers).toFixed(1) : null,
      mean: allMembers.length > 0 ? (allMembers.reduce((a, b) => a + b, 0) / allMembers.length).toFixed(1) : null,
    }, "Ensemble forecast fetched");

    return {
      members: allMembers,
      modelInfo: { gefs: gefsCount, ecmwf: ecmwfCount, total: allMembers.length },
    };
  } catch (err) {
    logger.error({ module: "weather", city: city.name, err: err.message }, "Failed to fetch ensemble forecast");
    return { members: [], modelInfo: { gefs: 0, ecmwf: 0, total: 0 } };
  }
}

// ── BRACKET PROBABILITY COMPUTATION ──

/**
 * Given a set of Kalshi temperature brackets and ensemble member temperatures,
 * compute the probability for each bracket.
 *
 * Kalshi brackets are typically:
 *   - "Below X°F"
 *   - "X to Y°F" (2°F intervals)
 *   - "Above Z°F"
 *
 * @param {number[]} members - Array of ensemble member daily high temps (°F)
 * @param {Array<{ticker: string, low: number|null, high: number|null}>} brackets
 *        Each bracket has low (inclusive) and high (exclusive). null = unbounded.
 * @returns {Array<{ticker: string, probability: number, memberCount: number}>}
 */
export function computeBracketProbabilities(members, brackets) {
  if (members.length === 0) return brackets.map(b => ({ ...b, probability: 0, memberCount: 0 }));

  const total = members.length;

  return brackets.map(bracket => {
    const count = members.filter(temp => {
      // Low bound: inclusive (temp >= low). null = no lower bound.
      if (bracket.low != null && temp < bracket.low) return false;
      // High bound: exclusive (temp < high). null = no upper bound.
      if (bracket.high != null && temp >= bracket.high) return false;
      return true;
    }).length;

    return {
      ...bracket,
      probability: count / total,
      memberCount: count,
    };
  });
}

// ── PARSE KALSHI MARKET BRACKETS ──

/**
 * Parse Kalshi temperature market titles into bracket bounds.
 *
 * Kalshi markets use yes_sub_title like:
 *   "79°F or below"     → { low: null, high: 80 }
 *   "80°F to 81°F"      → { low: 80, high: 82 }
 *   "82°F or above"     → { low: 82, high: null }
 *
 * Also handles formats like:
 *   "80 - 81"
 *   "Below 79"
 *   "Above 82"
 *   "≥ 82°F"
 *   "≤ 79°F"
 *
 * @param {string} title - The market title/subtitle
 * @returns {{ low: number|null, high: number|null } | null}
 */
export function parseBracketFromTitle(title) {
  if (!title) return null;

  // Normalize: remove °F, °, extra spaces
  const clean = title.replace(/°F?/g, "").trim();

  // "X or below" / "below X" / "≤ X" / "under X"
  let match = clean.match(/(\d+)\s*or\s*below/i) ||
              clean.match(/below\s*(\d+)/i) ||
              clean.match(/[≤<=]\s*(\d+)/i) ||
              clean.match(/under\s*(\d+)/i);
  if (match) {
    return { low: null, high: parseInt(match[1]) + 1 };
  }

  // "X or above" / "above X" / "≥ X" / "over X" / "X+"
  match = clean.match(/(\d+)\s*or\s*above/i) ||
          clean.match(/above\s*(\d+)/i) ||
          clean.match(/[≥>=]\s*(\d+)/i) ||
          clean.match(/over\s*(\d+)/i) ||
          clean.match(/(\d+)\s*\+/);
  if (match) {
    return { low: parseInt(match[1]), high: null };
  }

  // "X to Y" / "X - Y" / "X–Y"
  match = clean.match(/(\d+)\s*(?:to|[-–])\s*(\d+)/i);
  if (match) {
    return { low: parseInt(match[1]), high: parseInt(match[2]) + 1 };
  }

  return null;
}

// ── FETCH ALL FORECASTS ──

/**
 * Fetch ensemble forecasts for all cities for a target date.
 * Returns a map: cityCode → { members, modelInfo }
 */
export async function fetchAllForecasts(targetDate) {
  const results = {};

  // Fetch all cities in parallel
  const entries = Object.entries(CITIES);
  const forecasts = await Promise.all(
    entries.map(([code, city]) => fetchEnsembleForecast(city, targetDate))
  );

  for (let i = 0; i < entries.length; i++) {
    results[entries[i][0]] = forecasts[i];
  }

  const totalMembers = Object.values(results).reduce((sum, r) => sum + r.members.length, 0);
  logger.info({
    module: "weather",
    targetDate,
    cities: entries.length,
    totalMembers,
  }, "All city forecasts fetched");

  return results;
}

// ── ACTUAL OBSERVED TEMPERATURE (for settlement) ──

const OPEN_METEO_HISTORICAL_URL = "https://api.open-meteo.com/v1/forecast";

/**
 * Fetch the actual observed high temperature for a city on a given date.
 * Uses Open-Meteo's historical/recent weather data (free, no key).
 *
 * @param {string} cityCode - City code (NYC, CHI, etc.)
 * @param {string} date - YYYY-MM-DD
 * @returns {number|null} Actual high temp in °F, or null if unavailable
 */
export async function fetchActualHigh(cityCode, date) {
  const city = CITIES[cityCode];
  if (!city) return null;

  try {
    const resp = await axios.get(OPEN_METEO_HISTORICAL_URL, {
      params: {
        latitude: city.lat,
        longitude: city.lon,
        daily: "temperature_2m_max",
        temperature_unit: "fahrenheit",
        start_date: date,
        end_date: date,
        timezone: "America/New_York",
      },
      timeout: 10_000,
    });

    const temps = resp.data?.daily?.temperature_2m_max;
    if (temps && temps.length > 0 && temps[0] != null) {
      logger.info({
        module: "weather",
        city: city.name,
        date,
        actualHigh: temps[0],
      }, "Actual high temperature fetched");
      return temps[0];
    }
    return null;
  } catch (err) {
    logger.error({ module: "weather", city: city.name, date, err: err.message }, "Failed to fetch actual high");
    return null;
  }
}

/**
 * Get yesterday's date in YYYY-MM-DD format (ET timezone).
 */
export function getYesterdayDateET() {
  const now = new Date();
  const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  etDate.setDate(etDate.getDate() - 1);
  return etDate.toISOString().split("T")[0];
}

/**
 * Get tomorrow's date in YYYY-MM-DD format (ET timezone).
 */
export function getTomorrowDateET() {
  const now = new Date();
  // Convert to ET: UTC-4 (EDT) or UTC-5 (EST)
  // Use Intl to get the correct offset
  const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  etDate.setDate(etDate.getDate() + 1);
  return etDate.toISOString().split("T")[0];
}

/**
 * Get today's date in YYYY-MM-DD format (ET timezone).
 */
export function getTodayDateET() {
  const now = new Date();
  const etDate = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return etDate.toISOString().split("T")[0];
}
