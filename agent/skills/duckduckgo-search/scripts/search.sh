#!/usr/bin/env bash
set -euo pipefail

# DuckDuckGo HTML search — curl + awk parser, zero external dependencies
# Usage: ./search.sh "query" [count]

query="$1"
count="${2:-10}"
user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

# URL-encode the query
if command -v python3 &>/dev/null; then
  encoded=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.stdin.read()))" <<< "$query" 2>/dev/null)
elif command -v xxd &>/dev/null; then
  encoded=$(printf '%s' "$query" | xxd -plain | tr -d '\n' | sed 's/\(..\)/%\1/g')
else
  # crude fallback: replace spaces with +, pass through special chars
  encoded=$(printf '%s' "$query" | sed 's/ /+/g')
fi

curl -s "https://html.duckduckgo.com/html/?q=${encoded}" \
  -H "User-Agent: ${user_agent}" \
  -H "Accept-Language: en-US,en;q=0.9" | awk -v max="$count" '
function decode(str) {
  gsub(/\+/, " ", str)
  while (match(str, /%[0-9a-fA-F][0-9a-fA-F]/)) {
    hex = substr(str, RSTART+1, 2)
    code = sprintf("%c", strtonum("0x" hex))
    str = substr(str, 1, RSTART-1) code substr(str, RSTART+3)
  }
  return str
}

function strip(html) {
  gsub(/<[^>]*>/, "", html)
  gsub(/&#x27;|&#39;/, "\047", html)
  gsub(/&amp;/, "\\&", html)
  gsub(/&lt;/, "<", html)
  gsub(/&gt;/, ">", html)
  gsub(/&quot;/, "\"", html)
  gsub(/&#[0-9]+;/, "", html)
  return html
}

BEGIN {
  RS = "<div class=\"result results_links results_links_deep web-result"
  found = 0
}

NR > 1 && found < max {
  title = ""; url = ""; snippet = ""

  if (match($0, /class="result__a"[^>]*>([^<]+)</, a)) title = a[1]
  if (match($0, /uddg=([^&]+)/, b)) url = b[1]
  if (match($0, /class="result__snippet"[^>]*>([^<]+)</, c)) snippet = c[1]

  if (title != "" && url != "") {
    found++
    printf "  %d. %s\n", found, strip(title)
    printf "     URL: %s\n", decode(url)
    if (snippet != "") printf "     %s\n", strip(snippet)
    printf "\n"
  }
}
'