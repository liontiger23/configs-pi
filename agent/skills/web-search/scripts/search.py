#!/usr/bin/env python3
"""DuckDuckGo HTML search — Python 3 stdlib only.

Usage: search.py "query" [count]
Prints numbered results: title, decoded URL, snippet.
Exits 1 with a clear message if DDG returns nothing (rate limit or markup
change) — do not treat a failure as "no results exist".
"""

import html
import re
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://html.duckduckgo.com/html/?q="
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}

ANCHOR_RE = re.compile(r'<a\b([^>]*\bresult__a\b[^>]*)>(.*?)</a>', re.S)
HREF_RE = re.compile(r'href="([^"]*)"')
SNIPPET_RE = re.compile(r'<a\b[^>]*\bresult__snippet\b[^>]*>(.*?)</a>', re.S)
TAG_RE = re.compile(r'<[^>]+>')


def clean(s: str) -> str:
    """Strip tags, decode entities, collapse whitespace."""
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub("", s))).strip()


def decode_url(href: str) -> str:
    """DDG wraps destinations in /l/?uddg=<urlencoded>; recover the real URL."""
    m = re.search(r"[?&]uddg=([^&]+)", href)
    return urllib.parse.unquote(m.group(1)) if m else html.unescape(href)


def fetch_page(query: str) -> str:
    req = urllib.request.Request(ENDPOINT + urllib.parse.quote(query), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode("utf-8", errors="replace")


def search(query: str, count: int) -> list[tuple[str, str, str]]:
    page = fetch_page(query)

    anchors = []
    for m in ANCHOR_RE.finditer(page):
        href = HREF_RE.search(m.group(1))
        title = clean(m.group(2))
        if href and title:
            anchors.append((title, decode_url(href.group(1))))

    # Snippets appear in document order, one per result.
    snippets = [clean(s) for s in SNIPPET_RE.findall(page)]

    results = []
    for i, (title, url) in enumerate(anchors[:count]):
        results.append((title, url, snippets[i] if i < len(snippets) else ""))
    return results


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit('Usage: search.py "query" [count]')
    query = sys.argv[1]
    try:
        count = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    except ValueError:
        sys.exit('Usage: search.py "query" [count]')

    results = []
    for attempt in (1, 2):
        try:
            results = search(query, count)
        except Exception as e:  # network errors, HTTP 4xx/5xx, decode issues
            print(f"Attempt {attempt}: request failed: {e}", file=sys.stderr)
        if results:
            break
        if attempt == 1:
            time.sleep(2)

    if not results:
        sys.exit(
            "DDG returned no results — rate limit, block, or markup change. "
            "This is a fetch/parse failure, not proof that no results exist."
        )

    for i, (title, url, snippet) in enumerate(results, 1):
        print(f"  {i}. {title}")
        print(f"     URL: {url}")
        if snippet:
            print(f"     {snippet}")
        print()


if __name__ == "__main__":
    main()
