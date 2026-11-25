---
name: next
description: >-
  Inspect the current conversation progress and workspace state, then present
  up to 3 concrete, context-aware Chinese next-step suggestions as a native
  clickable ask_question card. Use when the user invokes /next or asks for
  interactive next-step options to choose from.
---

# Interactive Next-Step Suggestions (`/next`)

Surface up to 3 concrete, high-signal next steps in Chinese using the native
`ask_question` UI card so the user can pick one with a single click.

## Steps

1. **Gather lightweight ground truth (best-effort)**
   - Review what was just completed, changed, or left open in the current
     conversation.
   - If an active workspace exists, looks like a git repository, and you do not
     already have fresh working-tree status from this turn, run one quick
     read-only check (`git status --short`). If the output is large, summarize
     only the first ~30 entries.
   - If both conversation progress and working-tree changes are empty (cold
     start) inside a git repository, optionally run `git log -n 3 --oneline` to
     pick up recent context.
   - Treat git commands strictly as best-effort: skip them when no workspace is
     active or the session is non-code; if a command fails, the directory is not
     a git repo, or execution policy denies it, do **not** retry or surface an
     error—fall back immediately to conversation context.
   - **Cold-start exit**: If there is still no concrete task, file change, or
     open decision to anchor suggestions on, **skip `ask_question`**. Reply in
     one brief Chinese sentence stating there are no active changes or tasks yet
     and ask what the user would like to work on.

2. **Draft up to 3 concrete options (in Chinese)**
   - Draft typically 2–3 options (or 1 if only one worthwhile action exists);
     never pad with vague placeholders.
   - Ground every option in real files, commands, tests, diffs, or open
     decisions from the session, and propose **only** actions directly
     executable with the current tools and context.
   - Keep each option to one crisp line (~25–30 Chinese characters where
     practical), ordered from highest-value immediate action to follow-up /
     wrap-up (e.g., verify/test → refine/edge case → commit/document).
   - Follow `ask_question`'s UI contract strictly:
     - Prefix the first (best) option with `(Recommended) ` and do **not** also
       append `（推荐）` at the end.
     - Leave options **unnumbered** and do **not** include an "Other" option
       (the UI adds numbering and "Other" automatically).

3. **Present the native clickable card (with plain-text fallback)**
   - Call `ask_question` with a single short question such as `"接下来想先做哪一步？"`
     and the drafted options.
   - Do not also append a duplicate plain-text `下一步建议` list before calling
     `ask_question`.
   - If `ask_question` is unavailable in the current environment or fails, fall
     back to the plain-text numbered `下一步建议` format defined in
     `rules/AGENTS.md`.

4. **Handle the user's response**
   - If the user cancels/dismisses the card or indicates via Other not to
     proceed (e.g., "算了" / "先不做"), stop cleanly with a brief acknowledgment
     without executing any action.
   - Otherwise execute the chosen step directly without asking for a second
     confirmation (unless the action is destructive, irreversible, has external
     side effects such as `git push` or release, or genuinely misses required
     input).
