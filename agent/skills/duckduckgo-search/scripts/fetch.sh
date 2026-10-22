#!/usr/bin/env bash
set -euo pipefail

# Fetch URL and extract clean readable text
# Uses w3m (preferred) or lynx for proper HTML-to-text rendering.
# Falls back to crude awk stripping if neither is available.
# Usage: ./fetch.sh <url>

url="$1"
user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

if [ -z "$url" ]; then
  echo "Usage: $0 <url>" >&2
  exit 1
fi

html=$(curl -sL "$url" \
  -H "User-Agent: ${user_agent}" \
  -H "Accept-Language: en-US,en;q=0.9" \
  --max-time 30 2>/dev/null) || {
  echo "Failed to fetch URL" >&2
  exit 1
}

if [ -z "$html" ]; then
  echo "Empty response" >&2
  exit 1
fi

# Preferred: w3m for clean structured text
if command -v w3m &>/dev/null; then
  echo "$html" | w3m -dump -T text/html -cols 80 2>/dev/null | awk '
    # Filter out common navigation/UI lines from w3m output
    /^Jump to content/ { next }
    /^Main menu/ { next }
    /^\(Move / { next }
    /^\(BUTTON\)/ { next }
    /^\[image[^]]*\]/ { next }
    /^\[[0-9]+px-/ { next }
    /^  • / { next }
    /^Navigation$/ { next }
    /^Contribute$/ { next }
    /^        / && /Actions/ { next }
    /^        / && /General/ { next }
    /^        / && /Print\/export/ { next }
    /^        / && /In other projects/ { next }
    /^Appearance$/ { next }
    /^\[ \] / { next }
    /^\[enwiki\]/ { next }
    /^Search$/ { next }
    /^\[ *\]$/ { next }
    /^Donate$/ { next }
    /^Create account$/ { next }
    /^Log in$/ { next }
    /^Personal tools$/ { next }
    /^Tools$/ { next }
    /^Tools$/ { next }
    /^\[\+\] / { next }  # collapsible sections in some UIs
    /^\[\-\] / { next }
    { print }
  ' | head -500

# 2nd choice: lynx
elif command -v lynx &>/dev/null; then
  echo "$html" | lynx -stdin -dump -nolist -width 80 2>/dev/null | head -500

# Fallback: crude awk tag-stripping
else
  echo "$html" | awk '
    /<title>/ {
      match($0, /<title>([^<]*)<\/title>/, t)
      if (t[1] != "") title = t[1]
    }
    /<body/ { in_body = 1 }
    /<\/body/ { in_body = 0 }
    in_body {
      line = $0
      gsub(/<script[^>]*>([^<]*<\/script>)?/, "", line)
      gsub(/<style[^>]*>([^<]*<\/style>)?/, "", line)
      gsub(/<[^>]*>/, " ", line)
      gsub(/&amp;/, "\\&", line)
      gsub(/&lt;/, "<", line)
      gsub(/&gt;/, ">", line)
      gsub(/&quot;/, "\"", line)
      gsub(/&#x27;/, "'\''", line)
      gsub(/&#39;/, "'\''", line)
      gsub(/&nbsp;/, " ", line)
      gsub(/&#[0-9]+;/, "", line)
      gsub(/\s+/, " ", line)
      gsub(/^ +| +$/, "", line)
      if (line != "") print line
    }
    END {
      if (title != "") print "\n[Title: " title "]"
    }
  ' | head -300
fi