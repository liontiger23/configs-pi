#!/usr/bin/env bash
set -eu

# Fetch a URL and render it as clean text via w3m.
# Usage: ./fetch.sh <url>   (run relative to this skill directory)

url="${1:?Usage: fetch.sh <url>}"
user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

html=$(curl -fsSL --max-time 30 \
  -H "User-Agent: ${user_agent}" \
  -H "Accept-Language: en-US,en;q=0.9" \
  "$url") || { echo "Fetch failed (HTTP error, timeout, or empty body): $url" >&2; exit 1; }

[ -n "$html" ] || { echo "Empty response: $url" >&2; exit 1; }

# -T text/html is required when w3m reads from stdin.
text=$(printf '%s' "$html" | w3m -dump -T text/html -cols 80) \
  || { echo "w3m rendering failed for: $url" >&2; exit 1; }

head -500 <<<"$text"
