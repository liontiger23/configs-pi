---
name: upsource
description: View and respond to JetBrains Upsource code reviews. Use when the user mentions an Upsource review URL, review IDs like PROJ-CR-123, asks to check review comments, fix code per review feedback and reply "Fixed", or post clarification comments.
---

# Upsource code reviews

Work with Upsource using the `upsource` CLI (installed at `~/.local/bin/upsource`,
on PATH). This skill only explains the workflow — the CLI is maintained separately
(source: `cli/upsource` in the workspace repo; re-install with `install.sh`).

If `upsource` is not found on PATH, try `~/.local/bin/upsource`; if that is also
missing, tell the driver to run `install.sh` from the workspace repo.

Review IDs look like `PROJ-CR-123` (project code `PROJ` + `-CR-` + number); a
review URL `.../PROJ/review/PROJ-CR-123` maps to the id `PROJ-CR-123`.
Substitute the project code and review id from the URL or the user's request.

## Auth (gh-style, already configured)

The driver logs in once: `upsource auth login` (hidden prompt) or
`upsource auth login --with-token < keyfile`. The token is stored in
`~/.config/upsource/hosts.json` (0600); afterwards every command just works —
no env vars, no flags. `$UPSOURCE_CREDENTIALS` (path to a file) overrides the
saved config.

**Never read, print, or echo any token/credentials file** and never put a key in
command text, code, logs, or URLs. For auth diagnostics use `auth status`
(masked token). Useful subcommands:

```bash
upsource auth login [--with-token]     # driver-only; saves the key
upsource auth status                   # hosts, user, masked token
upsource auth logout / auth token      # logout; print token (scripting only)
```

`auth token` prints the secret — never use it in agent workflows; commands
authenticate themselves.

## Commands

The default server comes from the saved auth config (override with `--url` or
`UPSOURCE_URL`; with multiple saved hosts, use `--url`).

```bash
upsource --help                       # discover subcommands
upsource projects                     # list projects
upsource reviews <project> --query "state: open"
upsource review PROJ-CR-123           # review details
upsource discussions PROJ-CR-123      # all threads w/ comments
upsource discussions PROJ-CR-123 --unresolved
upsource reply PROJ-CR-123 <discussionId> "text"
upsource comment PROJ-CR-123 "text" [--file F --revision R --line N]
upsource branches <project> <query>   # branch names carry '#<repo-alias>'
upsource revisions <project> --query 'branch: "name#repo-alias"'
upsource review-revisions PROJ-CR-123 # revisions attached to the review
upsource add-revision PROJ-CR-123 <upsourceRevisionId>   # attach aux-repo commit
upsource remove-revision PROJ-CR-123 <upsourceRevisionId>
upsource --json <subcommand>          # raw JSON for machine use (--json works anywhere)
upsource raw <Method> '<json-body>'   # any ~rpc call (always emits JSON)
upsource api [pattern]                # embedded catalog: list methods (174)
upsource api-show <Method|DTO>        # full field details for a method or DTO
upsource call <Method> k=v ...        # validated call (dotted keys nest; --dry to preview)
```

## Workflow: fixing code per review comments

1. Fetch discussions. Sort out, for each thread, whether it asks for a code fix
   or only an explanation.
2. For fix-threads: implement the fix in the working tree, build/test as the
   project requires. Verify before replying.
3. Reply to the thread with `reply`:
   - Just `Fixed` when the fix follows the reviewer's point unambiguously —
     no details, no commit hashes (the `[ai]` tag is added automatically).
     The diff is attached to the review; the reviewer sees it.
   - If there is nuance — a partial fix, a deviation from the suggestion, a
     non-obvious consequence — say so: what was done, what remains, and why.
   - If the thread raises a question or something to discuss rather than a
     clear fix request, reply with the answer/discussion instead; do not
     pretend it is fixed.
4. **Never resolve the thread** — the reviewer decides and resolves it themselves.
   Only use `resolve` if the reviewer explicitly asked you to.
5. For explanation-only threads: `reply` with the explanation (code snippet,
   reasoning, links).

## Workflow: adding commits from auxiliary repos (multi-repo reviews)

A review automatically picks up new commits only from the **main repo's branch**
(shown in `review ...` under Branches, e.g. `<user>/feature#compiler`). Commits
in auxiliary repos of the same project are **not** added automatically — attach
them explicitly:

1. Find the aux branch. VCS roots appear as `#<alias>` suffixes on branch names;
   the alias is NOT the repo's name. Never guess — discover:

   ```bash
   upsource branches <project> <branch-prefix>
   # the branch whose review=<reviewId> column is set is the tracked main one;
   # same name with other aliases (#alias1, #alias2, ...) are auxiliary
   ```

2. List the commits on the aux branch and compare with what the review already has:

   ```bash
   upsource revisions <project> --query 'branch: "user/feature#alias2"'
   upsource review-revisions PROJ-CR-123
   ```

   Quote the branch in the query: an unquoted `#` starts a subquery and errors
   with `Unknown subquery ...`. Revision ids are prefixed with the repo alias
   (`alias2-<hash>`), not raw VCS hashes.

3. Attach the commit(s) that are missing:

   ```bash
   upsource add-revision PROJ-CR-123 alias2-abc1234...
   ```

4. Verify with `review-revisions`. To undo a mistaken attach:
   `remove-revision` (but don't remove revisions you didn't add without asking).

Do **not** use `startBranchTracking` to add an aux branch — it errors on reviews
that already track a branch (`Review cannot be converted to a branch review...`);
it is only for converting non-tracking reviews.

## Etiquette (acting under the driver's account)

The agent uses the driver's API key, so Upsource cannot distinguish agent-posted
comments from the driver's manual ones — they share one identity. Two signals
disambiguate them in `discussions` output:

- `[ai]` prefix — the comment was posted by an agent. `reply` and `comment` add
  it automatically (idempotent; `--no-ai-tag` opts out). Never strip or edit it.
- `(account)` marker — the comment was posted under the authenticated account:
  with the `[ai]` tag it's a prior agent reply; without it, it's the driver's own
  manual comment — treat it as instructions, re-read before acting, never dismiss
  it as "mine".
- Other named users' comments are reviewer input.

Rules:

- One `Fixed` reply per thread, unless the reviewer answers back. After replying,
  re-read `discussions` to confirm the reply landed and check for new messages.
- Never edit or remove comments (including your own) unless the driver
  explicitly asks; never close reviews; never resolve threads (see workflow).
- Write access (`reply`, `comment`, `resolve`, `add-revision`) is real:
  double-check ids and text before running. If unsure which thread a comment
  belongs to, re-fetch discussions first.

## Troubleshooting

- `HTTP 400 code 100: Method 'X' not found` — wrong method name for this server
  version; the embedded catalog is authoritative: `upsource api -i <keyword>`
  and `upsource api-show <name>`.
- `Request message is not initialized` / `Cannot deserialize params` — the body
  shape is wrong; Upsource expects **flat** DTO fields (with nested exceptions —
  see `references/api.md` for the verified shapes) or a required field is
  missing (`upsource api-show <Method>` lists them).
- Connection refused / 401 — check VPN/network; run `upsource auth status`; if
  `not logged in`, ask the driver to run `upsource auth login`.
