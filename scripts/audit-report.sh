#!/usr/bin/env bash
#
# audit-report.sh — Fetch Sentinel's admin audit stats and pretty-print.
#
# Reads SENTINEL_ADMIN_KEY from ~/Documents/Sentinel/.env (gitignored),
# scopes it to the curl invocation (not the parent shell), and pipes
# the JSON through python3 for readable output.
#
# Usage:
#   ./scripts/audit-report.sh              # default: /admin/stats
#   ./scripts/audit-report.sh audit        # full audit trail
#   ./scripts/audit-report.sh summary      # aggregated summary
#

set -euo pipefail

ENV_FILE="${HOME}/Documents/Sentinel/.env"
BASE_URL="https://sentinel-awms.onrender.com"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found" >&2
  exit 1
fi

# Pick endpoint based on first arg
case "${1:-stats}" in
  stats)   PATH_SUFFIX="/admin/stats" ;;
  audit)   PATH_SUFFIX="/admin/audit" ;;
  summary) PATH_SUFFIX="/admin/audit/summary" ;;
  *)       echo "Unknown mode: $1 (use stats|audit|summary)" >&2; exit 1 ;;
esac

# Scope the secret to just the curl process — don't export into the shell.
env $(grep '^SENTINEL_ADMIN_KEY=' "$ENV_FILE" | xargs) \
  bash -c 'curl -sS -H "Authorization: Bearer $SENTINEL_ADMIN_KEY" "'"${BASE_URL}${PATH_SUFFIX}"'"' \
  | python3 -m json.tool
