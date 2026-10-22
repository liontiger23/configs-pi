# Pi configs

This repo is a collection of various [Pi](https://github.com/earendil-works/pi) coding agent configs that I personally use.

## Installation

1. Clone this repository
1. Run `bootstrap` script, which creates symlink at `~/.pi` to cloned repository.
1. Open `pi` and it will automatically pick up extensions, skills and settings from the cloned repository

## Contents

Skills and extensions are mostly created and edited by the agent — keep this summary in sync when adding or changing them.

### Extensions (`agent/extensions/`)

- [no-root-scan.ts](agent/extensions/no-root-scan.ts) — blocks bash commands that scan the filesystem root (`find /`, `du -sh /`, `rg foo /`, …), while allowing innocuous uses like `cat /etc/hosts`
- [pin.ts](agent/extensions/pin.ts) — compaction-proof pinned context: pin text, files, or skills into the system prompt via `/pin`; stored per session in `<session-file>.pin.md`
- [routerai-provider.ts](agent/extensions/routerai-provider.ts) — custom provider for [RouterAI](https://routerai.ru): live model catalog with per-million-token prices, `/routerai-models` price picker, context clamping for auto-compaction, GLM reasoning replay
- [turn-timer.ts](agent/extensions/turn-timer.ts) — wall-clock run timer: measures time from prompt start until pi settles

### Skills (`agent/skills/`)

- [duckduckgo-search](agent/skills/duckduckgo-search/SKILL.md) — web search and page content extraction via DuckDuckGo's HTML endpoint; no API key, uses only curl and awk
- [pair](agent/skills/pair/SKILL.md) — pair programmer mode: plan first, do only what is asked, pause and ask on surprises; deep dives only on explicit request
- [tutor](agent/skills/tutor/SKILL.md) — tutoring mode: Socratic, step-by-step teaching instead of giving answers outright

## Notes

- Runtime files (`agent/sessions/`, `agent/auth.json`, `agent/models-store.json`, `agent/trust.json`, `agent/npm/`) live inside the repository but are gitignored, see `.gitignore`
- `agent/auth.json` contains API keys and OAuth tokens — never commit it
