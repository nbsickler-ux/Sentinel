#!/usr/bin/env bash
# ============================================================
# Render Build Script — Sentinel
# ============================================================
# Decrypts the proprietary scoring engine from the encrypted
# file committed to the repo (lib/scoring-engine.enc).
# The decryption key is stored in Render as SCORING_ENGINE_KEY.
# The decrypted module is gitignored and never committed.
# ============================================================

set -euo pipefail

echo "==> Sentinel build starting..."

# 1. Decrypt the private scoring engine
if [ -z "${SCORING_ENGINE_KEY:-}" ]; then
  echo "ERROR: SCORING_ENGINE_KEY env var is not set."
  echo "The scoring engine cannot be decrypted. Aborting build."
  exit 1
fi

mkdir -p lib/scoring-engine
openssl enc -aes-256-cbc -d -pbkdf2 \
  -in lib/scoring-engine.enc \
  -out lib/scoring-engine/index.js \
  -pass pass:"$SCORING_ENGINE_KEY"

# Verify the file was written and is non-empty
if [ ! -s lib/scoring-engine/index.js ]; then
  echo "ERROR: lib/scoring-engine/index.js is empty after decryption."
  exit 1
fi

FILE_SIZE=$(wc -c < lib/scoring-engine/index.js)
echo "==> Scoring engine decrypted (${FILE_SIZE} bytes)"

# 2. Syntax-check the decrypted file
node --check lib/scoring-engine/index.js
echo "==> Scoring engine syntax OK"

# 3. Install dependencies
npm install
echo "==> Dependencies installed"

echo "==> Sentinel build complete"
