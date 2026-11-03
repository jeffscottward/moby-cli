#!/usr/bin/env bash
# Pre-push check: gitleaks on the full history plus a grep for token-like strings.
set -euo pipefail
cd "$(dirname "$0")/.."
gitleaks git --redact --no-banner .
if git ls-files -z | grep -zv '^scripts/secret-scan.sh$' | xargs -0 grep -nIE 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|AMf-[A-Za-z0-9_-]{40,}|@gmail\.com|moby-prod-[0-9]+'; then
  echo "secret-scan: suspicious strings found" >&2; exit 1
fi
echo "secret-scan: clean"
