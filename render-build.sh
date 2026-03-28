#!/usr/bin/env bash
# ============================================================
# Render Build Script — Sentinel
# ============================================================
# Reconstructs the private scoring engine module from a
# base64-encoded environment secret before installing deps.
# The scoring engine is gitignored so it never appears in
# the public repo. Render stores it as SCORING_ENGINE_B64.
# ============================================================

set -euo pipefail

echo "==> Sentinel build starting..."

# 1. Reconstruct the private scoring engine
if [ -z "${SCORING_ENGINE_B64:-}" ]; then
  echo "ERROR: SCORING_ENGINE_B64 env var is not set."
  echo "The scoring engine cannot be reconstructed. Aborting build."
  exit 1
fi

mkdir -p lib/scoring-engine
echo "$SCORING_ENGINE_B64" | base64 -d > lib/scoring-engine/index.js

# Verify the file was written and is non-empty
if [ ! -s lib/scoring-engine/index.js ]; then
  echo "ERROR: lib/scoring-engine/index.js is empty after decoding."
  exit 1
fi

FILE_SIZE=$(wc -c < lib/scoring-engine/index.js)
echo "==> Scoring engine reconstructed (${FILE_SIZE} bytes)"

# 2. Syntax-check the reconstructed file
node --check lib/scoring-engine/index.js
echo "==> Scoring engine syntax OK"

# 3. Install dependencies
npm ci
echo "==> Dependencies installed"

echo "==> Sentinel build complete"
