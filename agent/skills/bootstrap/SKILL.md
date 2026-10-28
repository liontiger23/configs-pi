---
name: bootstrap
description: >
  Prepare an empty (or near-empty) directory for development or investigation
  of a project — the user's own or third-party. Sets up git, an AGENTS.md with
  a context-restore protocol, docs skeleton (status, plans, notes), and an
  untracked repos/ directory for third-party clones. Invoke explicitly via
  /skill:bootstrap.
disable-model-invocation: true
---

# Bootstrap a working directory

Prepare an empty (or near-empty) directory for investigating or developing a
project, with documentation designed to restore context after compaction or
in new sessions.

## Before you start

Inspect the target directory first. Proceed if it is empty or contains only an
initial commit / stub README. If it already contains meaningful content
(source files, docs, other tooling), pause and ask the driver before changing
anything — do not clobber an existing structure.

If pair mode is active, agree on which project to target before cloning
anything into `repos/`.

## Setup steps

1. **Git** — run `git init` if there is no repository. If there is no initial
   commit yet, note it; the final commit below becomes it.
2. **`.gitignore`** — create with at least:
   ```gitignore
   # Third-party repositories and downloads (see AGENTS.md)
   repos/
   ```
   plus anything environment-specific already apparent (editor dirs, build
   output, `.env`).
3. **`repos/`** — create the directory. Third-party code clones and downloads
   live here; it must stay untracked. Never commit its contents to the working
   repository, and never commit the working repo's files into a clone inside
   `repos/`.
4. **`AGENTS.md`** — write it using the template below, filling in real values.
   It is the entry point for any future agent session: keep it short and stable.
5. **Docs skeleton**:
   - `docs/status.md` — the living state document (template below). This is
     the primary context-restoration artifact.
   - `docs/plans/` — one plan document per task, created when work starts.
   - `notes.md` — scratch space for investigation findings, links, raw output.
6. **Initial commit** of everything except `repos/`. Do not push.
7. **Target project** — ask the driver which project to work on, then clone or
   download it into `repos/`. If it's the driver's own project, record where it
   lives (URL or local path) in `AGENTS.md` and `docs/status.md`.

## AGENTS.md template

```markdown
# AGENTS.md

## What this directory is

<One or two sentences: what is being investigated/developed here, and why.>

## Layout

- `AGENTS.md` — this file: orientation and context-restore protocol
- `docs/status.md` — current task, findings, next steps; **source of truth for state**
- `docs/plans/` — one plan document per task (`docs/plans/<task>.md`)
- `notes.md` — scratch findings, links, raw output
- `repos/` — third-party clones and downloads; **untracked, never commit**

## Target project

- Project: <name>
- Origin: <git URL or local path>
- Local clone: `repos/<name>`

## Context-restore protocol

When starting a session (fresh or after compaction):

1. Read this file.
2. Read `docs/status.md` — it reflects the actual current state; trust it over
   stale conversation memory.
3. Read `docs/plans/<current-task>.md` if a task is in progress.
4. Skim `notes.md` only as needed.

Keep `docs/status.md` up to date: after every significant step (finding, plan
change, completed step), update it in the same edit round — not "later".
When a task finishes, move its outcome into `docs/status.md` (done items) and
delete or archive its plan file.
```

## docs/status.md template

```markdown
# Status

## Current task

<What is being worked on right now, or "none — awaiting direction".>

## Plan

<Link to docs/plans/<task>.md, or inline short list of steps.>

## Findings

<Facts learned so far, newest last. One line each with a date.>

## Next steps

<Concrete next actions, ordered.>
```

## Notes

- Keep the working repo's own history clean: one commit per logical setup
  change is enough.
- If the driver asks to adapt the structure (different doc names, monorepo
  layout, etc.), adapt — the templates above are defaults, not requirements.
  Record any deviation in `AGENTS.md` so future sessions follow the actual
  layout, not this template.
