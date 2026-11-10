---
name: topic-queue
description: Conversational queue of topic/task cards, processed in mini-sessions with the teacher, with decisions recorded to per-project markdown cards. Use when the teacher mentions the queue, wants the next topic, lists/bumps/parks/focuses topics, resumes brainstorming or an ongoing task, or wants an idea/task/research item turned into a tracked card. Per-project queue/ directory. NOT for PR review workflow (syspro-ta-review).
---

# Topic queue

A queue of **cards** (one markdown file per topic/task/research item), processed in
**mini-sessions** — small decision-or-work units. The chat is never the source of
truth; the cards are. Modeled on file-based agent task managers (Backlog.md et al.)
plus ADR-style decision logs inside each card.

## State: the `queue/` directory (per project)

Look for `queue/` in the working directory or its ancestors. If absent, offer to
create one (see Bootstrap below). Layout:

```
queue/
  QUEUE.md                    # ordered index = THE queue (bump = reorder a line)
  README.md                   # this project's standing rules + queue conventions
  c-0NN-slug.md               # cards; NNN = next free number
  research/c-0NN/…            # raw dumps (search results, links); never shown in chat whole
```

## Card format

```markdown
---
id: c-007
title: <short imperative title>
type: topic | task | research
status: inbox | ready | active | parked | done | dropped
priority: normal | high      # optional; "bump" also just reorders QUEUE.md
depends: [c-003]             # optional; "next" skips blocked cards
parent: c-002                # optional; for split-out children
created: YYYY-MM-DD
dropped-why:                 # mandatory reason when status: dropped
parked-until: <condition>    # mandatory condition when status: parked
---

## Goal
<what this is, why it exists — 1-3 lines>

## Options / interpretations
<when a topic: 2-4 named realizations with prep cost + feasibility
(verified | needs dry-run | blocked: <what>)>

## Decisions
<dated mini-ADR entries: **date — context → decision → why**>
<only decisions the teacher explicitly stated; tentative interest ≠ decision>

## Work log
<dated lines of what was done>

## Final doc
<the card grows into the deliverable: final plan / what was done, issues, leftovers>
```

## Verbs (map natural-language intent; never rigid commands)

- **list / queue / "what's next"** — show head of QUEUE.md: id, title, status, one-line
  state (≤7 cards unless asked; respect tag/topic filters if the teacher names some).
- **next** — run a mini-session on the first non-parked, non-blocked card.
- **focus <id|title-fragment>** — resume a card: RECAP its state from disk first
  (Goal + last Decisions + open point), then continue.
- **bump <id>** — move to top of QUEUE.md.
- **park <id> until/when <condition>**, **defer** (move to end of queue),
  **drop <id>** (reason mandatory), **blocked by <id/thing>**.
- **split <id>** — spawn child card(s), set `parent`, shrink the parent.
- **make this a topic / a card** — capture current discussion as a new card.
- **dump to disk** — save presented material (links, findings, drafts) to
  `queue/research/c-0NN/` instead of leaving it in chat.
- Natural-language replies during a mini-session map to the outcome vocabulary below;
  when ambiguous, ASK — never assume a decision happened.

## Mini-session protocol

1. **Recap first** (2-4 lines from the card: where it stands, last decision, open point).
2. Decision point: present **at most 3 options** (with one-line recommendation each),
   or do the work (see Work mode). No wall-of-text, no unsolicited deep-dive.
3. **Brainstorming rule (teacher, 2026-11-07): never discard or withhold ideas
   based on the TA's own reasoning.** Every idea generated — including ones the TA
   considered-and-filtered during internal deliberation — goes into the
   suggestions; the teacher must get the chance to confirm or reject each one.
   The TA attaches reasoning *for or against* as advice, but omission is a protocol
   violation; only the teacher decides. Full candidate list + one-line pool extras
   is acceptable form, provided nothing was silently filtered out.
4. Record the outcome to the card (Decisions/Work log), update QUEUE.md.
5. Commit + push per the project's conventions (if repo rules require it).
6. End with a one-line `Recorded: …` summary. Never end a mini-session without state
   written to disk.

**Work mode** (heavy actions: research, builds, writing docs): announce explicitly —
"work mode on <card>, nothing decided unless you say so". Heavy work always belongs to
its own mini-session; deciding sessions stay light. Results of heavy work are saved to
disk (card or research/), not into chat wholesale.

**Research mode** (for type: research or research-heavy work): collect full dumps to
`queue/research/<id>/`; present in chat **≤5 distilled one-liners**; anything worth
more becomes its own card ("needs more research").

**Deep-dives** happen only on explicit request ("dig into X") and are announced as
deep-dive mode: no verdicts recorded unless the teacher states one.
**Deep-dive pacing (teacher, 2026-11-08): never info-dump.** Walk the topic as a
step-by-step conversational flow — one sub-step per message, small verified example
or one decision per step, teacher reacts before the next step (same rhythm as
card-by-card triage, applied to sub-steps). A deep-dive needs an explicit
step-plan presented first (numbered, one line each); the teacher can steer or
skip steps.

## Outcome vocabulary (a decision exists only when the teacher states one)

- **decide** — dated mini-ADR entry in the card (context → decision → why)
- **flesh out** — extend the card body / options
- **do now** — work mode, outcome logged
- **defer / park** — re-queue or parked with a recorded revisit condition
- **split** — child card(s)
- **drop** — with mandatory one-sentence reason
- **blocked** — record what unblocks

## Anti-forgetting rules

- Chat is never the source of truth; the card is. Every return to a topic starts from
  the card on disk.
- Never end a mini-session without writing state to disk (and committing if the repo
  demands it).
- A card's status changes only via an explicit teacher statement; questions and
  "sounds interesting" leave status unchanged.
- If the teacher references a topic that has no card, offer to create one before
  proceeding.

## Bootstrap (creating a new queue)

1. Create `queue/` with `README.md` (project standing rules + any queue adaptations
   the teacher wants), `QUEUE.md`, and seeded cards as requested.
2. Numbering: `c-001`, `c-002`, … (zero-padded, globally unique per project).
3. This skill is user-level and shared across projects; per-project rules live in that
   project's `queue/README.md`. The teacher tweaks the protocol itself by editing this
   SKILL.md (plain markdown on purpose).
