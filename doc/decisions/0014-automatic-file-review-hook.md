# 0014 — Automatic per-file code review hook
- Status: Accepted
- Date: 2026-09-30

## Context
Every source change, whether made by Claude or by a person in an editor, should get an independent review right away, not only at the end of a phase.

## Decision
- **Reviewer:** `.claude/agents/code-reviewer.md` (Opus, read-only: Read/Grep/Glob/Skill; preloads `security-and-hardening` and `next-best-practices`).
  - It started in `.claude/subagent/` and was moved on 2026-09-30, so all seven agents live in one folder.
  - The hook runs it, and it can also be used by hand ("review src/lib/auth.ts").
  - Its checks, in priority order: project security rules → correctness → OWASP → Next.js/React → performance → types/maintainability → a11y. Every finding needs evidence (`path:line`, failure scenario, fix).
  - Severity scale: Critical / High / Medium / Low / Nit.
  - Its last line is `VERDICT: PASS|WARN|FAIL` with counts.
- **Hooks** (`.claude/settings.json`):
  - `PostToolUse` matcher `Write|Edit|MultiEdit` covers Claude-driven edits.
  - `FileChanged` covers edits made outside Claude.
    - Its matcher both sets the watched paths and gets compared with the changed file's basename.
    - So one entry watches `src|scripts|tests|e2e` (its command is a no-op), and a second entry with no matcher runs the review for every change.
  - Both are `asyncRewake`: the review runs in the background, and exit code 2 (a FAIL verdict) wakes Claude with the blocking findings.
- **Runner:** `.claude/hooks/review-changed-file.mjs` (Node, no dependencies).
  - Filters to `.ts/.tsx/.js/.jsx/.mjs/.cjs/.css` and skips `node_modules`, `.next`, `.claude`, `doc`, `public`, `*.d.ts` and files over 150 KB.
  - Debounce: 15 s for Claude edits, 20 s for external edits. Only the last event in a burst runs.
  - Deduplication:
    - A file Claude touched in the last 60 s is ignored by `FileChanged`, so Claude's edits are reviewed once and the feedback goes to Claude.
    - A sha256 check skips content that was already reviewed.
  - At most 2 reviews run at once, using lock-directory slots; stale slots are reclaimed.
  - The review itself:
    - It runs `claude -p --agent code-reviewer`. The model, tools and skills come from the agent's frontmatter.
    - Bash, Write, Edit, Web and Agent tools are disallowed, and no session is saved.
    - The prompt includes the git diff against HEAD.
    - The child process gets `CLAUDE_REVIEW_CHILD=1`, so a review can never trigger another review.
  - Output goes to `.claude/reviews/<path>.md` and `.claude/reviews/_log.jsonl`. The folder has its own `.gitignore` with `*`, so reports are never committed.
  - Infrastructure errors are logged and exit 0; they never block work.
- **Kill switch:** create `.claude/reviews/.disabled`, or set `CLAUDE_AUTO_REVIEW=off`.
- **Troubleshooting:** `CLAUDE_REVIEW_DEBUG=1` prints why a file was skipped. `CLAUDE_REVIEW_DEBOUNCE_MS` overrides the debounce time.
- **Verified 2026-09-30:**
  - A planted insecure admin route got FAIL (critical=2 high=1 medium=1) in 29 s and exit code 2.
  - Each skip path worked: content already reviewed, recent Claude edit, a non-source file, and the recursion guard.

## Consequences
- **Cost:** each reviewed file version is one Opus session, typically 20–60k tokens. Bulk operations such as scaffolding or codemods should switch the reviewer off first.
- The per-file review is fast feedback. It does not replace `qa-security-reviewer`, which still gates each phase with tests and cross-file checks.
- Hook changes take effect at session start. If `FileChanged` directories don't exist yet (`src/` before Phase 0 scaffolding), restart the session after creating them.
