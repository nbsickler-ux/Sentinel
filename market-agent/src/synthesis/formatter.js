// ============================================================
// BRIEFING FORMATTER
// Produces human-readable briefing output for dashboard + logs.
// ============================================================

/**
 * Format a briefing object into display-ready text.
 */
export function formatBriefing(briefing) {
  const lines = [];
  const divider = "─".repeat(60);

  lines.push(divider);
  lines.push(`  MARKET INTELLIGENCE BRIEFING — Cycle #${briefing.cycle}`);
  lines.push(`  ${briefing.timestamp}`);
  lines.push(divider);

  // Regime
  lines.push("");
  lines.push("  REGIME STATUS");
  lines.push(`  Current: ${briefing.regime.current.toUpperCase()} (confidence: ${(briefing.regime.confidence * 100).toFixed(0)}%)`);
  if (briefing.regime.rationale) {
    lines.push(`  Rationale: ${briefing.regime.rationale}`);
  }
  lines.push(`  Sentiment: ${formatSentiment(briefing.overall_sentiment)}`);

  // Trade Ideas
  lines.push("");
  lines.push(divider);
  lines.push("  TRADE IDEAS (ranked by confidence)");
  lines.push(divider);

  if (briefing.trade_ideas.length === 0) {
    lines.push("  No actionable setups this cycle.");
  } else {
    for (const idea of briefing.trade_ideas) {
      const arrow = idea.direction === "long" ? "▲" : idea.direction === "short" ? "▼" : "●";
      const adj = idea.qualitative_adjustment !== 0
        ? ` [qual: ${idea.qualitative_adjustment > 0 ? "+" : ""}${(idea.qualitative_adjustment * 100).toFixed(0)}%]`
        : "";
      lines.push("");
      lines.push(`  ${arrow} ${idea.pair} — ${idea.direction.toUpperCase()}`);
      lines.push(`    Confidence: ${(idea.confidence * 100).toFixed(1)}%${adj}`);
      lines.push(`    Regime: ${idea.regime} | Signals: ${idea.signal_count} | Agreement: ${((idea.agreement || 0) * 100).toFixed(0)}%`);
    }
  }

  // Signal Conflicts
  if (briefing.signal_conflicts.length > 0) {
    lines.push("");
    lines.push(divider);
    lines.push("  SIGNAL CONFLICTS");
    lines.push(divider);
    for (const conflict of briefing.signal_conflicts) {
      lines.push(`  ⚠ ${conflict.pair}: Quant says ${conflict.quant_direction}, qualitative adjusted to ${conflict.adjusted_direction}`);
      lines.push(`    Adjustment: ${(conflict.adjustment * 100).toFixed(0)}% — ${conflict.rationale}`);
    }
  }

  // On-Chain Highlights
  if (briefing.onchain_highlights.length > 0) {
    lines.push("");
    lines.push(divider);
    lines.push("  ON-CHAIN HIGHLIGHTS");
    lines.push(divider);
    for (const h of briefing.onchain_highlights) {
      const flags = [];
      if (h.indicators.accumulating) flags.push("ACCUMULATION");
      if (h.indicators.distributing) flags.push("DISTRIBUTION");
      if (h.indicators.large_transfers > 0) flags.push(`${h.indicators.large_transfers} whale txns`);
      lines.push(`  ${h.pair}: ${flags.length > 0 ? flags.join(", ") : "Normal activity"}`);
    }
  }

  // Key Themes
  if (briefing.key_themes.length > 0) {
    lines.push("");
    lines.push(divider);
    lines.push("  KEY THEMES");
    lines.push(divider);
    for (const theme of briefing.key_themes) {
      lines.push(`  • ${theme}`);
    }
  }

  // Overall Assessment
  if (briefing.overall_assessment && briefing.overall_assessment !== "No qualitative analysis available.") {
    lines.push("");
    lines.push(divider);
    lines.push("  ASSESSMENT");
    lines.push(divider);
    lines.push(`  ${briefing.overall_assessment}`);
  }

  // Data Sources
  lines.push("");
  lines.push(divider);
  lines.push("  DATA SOURCES");
  lines.push(divider);
  for (const [source, info] of Object.entries(briefing.data_sources || {})) {
    const status = info.status === "ok" ? `${info.count} pts (${info.latency_ms}ms)` : `ERROR: ${info.error}`;
    lines.push(`  ${source.padEnd(12)} ${status}`);
  }

  lines.push("");
  lines.push(divider);
  lines.push(`  Signals: ${briefing.signal_summary.total_signals} total`);
  lines.push(divider);

  return lines.join("\n");
}

function formatSentiment(s) {
  if (s > 0.3) return `Bullish (${(s * 100).toFixed(0)}%)`;
  if (s < -0.3) return `Bearish (${(s * 100).toFixed(0)}%)`;
  return `Neutral (${(s * 100).toFixed(0)}%)`;
}

/**
 * Format briefing as JSON for API responses.
 */
export function formatBriefingJSON(briefing) {
  const { formatted, ...data } = briefing;
  return data;
}
