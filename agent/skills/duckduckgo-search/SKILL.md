---
name: duckduckgo-search
description: Web search and page content extraction via DuckDuckGo's HTML endpoint (no API key required). Use for searching documentation, facts, news, or any web content. Also fetches page content from URLs. Uses curl and awk only — zero extra dependencies.
allowed-tools: bash curl
---

# DuckDuckGo Search & Fetch

Search the web via DuckDuckGo's anonymous HTML endpoint, then optionally fetch and read page content.

## Setup

No setup required. Relies on `curl` and `awk`.

## Search

```bash
./scripts/search.sh "your search query" [count]
```

- `count` is optional, defaults to 10 results
- Returns numbered results with title, decoded URL, and snippet

**Example:**
```bash
./scripts/search.sh "effect typescript library" 5
```

## Fetch Page Content

```bash
./scripts/fetch.sh <url>
```

- Fetches the URL and renders it as clean structured text
- Uses `w3m -dump` (preferred) or `lynx -dump` for proper HTML rendering with heading/section structure preserved
- Strips navigation, sidebars, scripts, styles — only visible content remains
- Follows redirects, 30 second timeout
- Output limited to 500 lines

**Example:**
```bash
./scripts/fetch.sh "https://en.wikipedia.org/wiki/Effect_(software)"
```

## Typical Workflow

1. **Search**: `./scripts/search.sh "topic"` → get relevant URLs
2. **Fetch**: `./scripts/fetch.sh "selected-url"` → read the actual page content
3. **Synthesize**: combine search results and page content for your answer

## How It Works

- DuckDuckGo's HTML endpoint at `https://html.duckduckgo.com/html/` provides search results without requiring any API key
- The `uddg` redirect URLs embedded in the HTML are automatically decoded back to real destination URLs
- For page content, `w3m -dump` renders HTML into structured plain text (headings separated by blank lines, paragraphs indented), which is ideal for LLM consumption compared to raw HTML
- Fetch falls back to `lynx -dump`, then to crude tag-stripping if neither is available

## GitHub Access — Prefer `gh` CLI

For any GitHub-related task (viewing repositories, issues, pull requests, releases,
code, gists, or any other GitHub content), **do not search via DuckDuckGo or fetch
GitHub URLs with `./scripts/fetch.sh`**. Instead, use the `gh` CLI directly:

```bash
# Examples of gh commands for common GitHub tasks:
gh repo view owner/repo
gh issue list -R owner/repo
gh issue view <number> -R owner/repo
gh pr list -R owner/repo
gh pr view <number> -R owner/repo
gh release list -R owner/repo
gh search repos "query"
gh search issues "query" -R owner/repo
```

- `gh` is pre-installed and authenticated on all of the user's machines
- It provides structured, token-efficient output directly — no scraping needed
- It is faster, more reliable, and respects API rate limits better than scraping

**Exception**: If a GitHub resource is not accessible via `gh` (e.g., GitHub Pages
sites, raw rendered README content with images), fall back to `./scripts/fetch.sh`.

## Quality Notes

- **Raw HTML is wasteful** — HTML markup, scripts, and styles consume many tokens and add noise. This skill renders pages to clean text, reducing token usage by 5-10x.
- **w3m preserves structure** — headings, paragraphs, and lists are preserved as readable text with proper spacing, unlike naive tag stripping which produces a wall of text.
- DuckDuckGo has rate limits but works well for assistant use cases.
- Results are anonymous — no tracking or personalization.