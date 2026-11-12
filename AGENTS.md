# AGENTS.md

## What this repo is

This repository is the live pi agent directory: `~/.pi` is a symlink to this
checkout. Files here take effect in new sessions, or via `/reload` for
settings, keybindings, instructions, resources, and extensions (reload
replaces the extension runtime).

## Layout

- `agent/extensions/` — TypeScript pi extensions. pi loads every direct
  `.ts`/`.js` file here as an extension (each needs a default factory export),
  and subdirectories containing an `index.ts`/`index.js` as one extension.
  Multi-file extensions use the subdirectory form: helper modules live next
  to `index.ts` and must NOT be placed as direct files in `extensions/`.
- `agent/skills/<name>/SKILL.md` — skills
- `agent/tests/` — extension tests (plain assert-based, no dev deps), run via
  the jiti loader bundled with pi against the real extension files
- `agent/settings.json` — pi settings
- Runtime data lives here too but is gitignored: `agent/sessions/`,
  `agent/npm/`, `agent/auth.json`, `agent/models-store.json`,
  `agent/trust.json`. Never read, modify, clean up, or commit these.

## Maintenance rules

- For how to write skills and extensions, consult pi's bundled documentation
  (`skills.md`, `extensions.md` in the pi package's `docs/` directory).
- After adding or changing an extension or skill, update the Contents
  section of `README.md` — keep the one-line descriptions accurate and the
  relative links working.
- After changing an extension, keep its test in `agent/tests/` passing and
  re-verify the extension still loads in a fresh `pi` session before
  committing. Tests are only needed where they make sense — pure logic worth
  regression-testing (parsers, detection rules, settings semantics); simple
  UI/glue extensions don't need one.
- Commit changes to git. Ask before pushing.
- `agent/settings.json` is live configuration, not code: extensions (e.g.
  routerai-provider's provider preferences, compaction threshold) and pi
  itself write to it at runtime. Changes to it must not be committed
  without the user's explicit approval — when a commit would include
  settings.json, call it out and ask first.
- Runtime data rules above apply equally to other extension-written files
  (e.g. `agent/routerai-endpoints.json`): keep them gitignored, never
  commit them.
