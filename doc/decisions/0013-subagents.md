# 0013 — Subagent roster and skill loading
- Status: Accepted
- Date: 2026-09-30
- Supersedes: the install-timing part of 0012

## Context
Work is split across specialised subagents. Each subagent preloads its skills through the `skills:` frontmatter field, so every skill an agent lists must already be installed. Installing skills per phase (ADR 0012) would break agents that list later-phase skills.

## Decision
Project subagents live in `.claude/agents/` (the only folder Claude Code loads project subagents from). All use `model: opus`.

| Agent | Owns | Main phases | Skills |
|---|---|---|---|
| `backend-architect` | `src/lib`, `src/models`, `src/app/api`, `src/proxy.ts`, `scripts/`, config | 0, 1, server side of 2/4/5/8 | next-best-practices, next-cache-components, mongodb-connection, security-and-hardening, tdd |
| `admin-panel-builder` | `src/app/admin`, `src/components/admin`, `src/components/ui` | 2, 5, 7, 8 (admin screens) | shadcn, next-best-practices, vercel-react-best-practices, vercel-composition-patterns, security-and-hardening |
| `import-engineer` | `src/lib/import`, `tests/fixtures`, import action | 3 | xlsx, tdd, security-and-hardening, next-best-practices |
| `site-frontend` | `src/app/(site)`, `(account)`, `whistleblower`, `src/components/site`, theme | 1 (shell), 4, 5, 7, 8, 9 | frontend-design, web-design-guidelines, next-best-practices, next-cache-components, vercel-react-best-practices, vercel-composition-patterns, seo |
| `motion-engineer` | `src/components/motion`, home page composition | 6 | gsap-core, gsap-scrolltrigger, gsap-react, gsap-timeline, gsap-performance, vercel-react-view-transitions, frontend-design, vercel-react-best-practices |
| `qa-security-reviewer` | tests only (`tests/`, `e2e/`) | end of every phase | security-and-hardening, playwright-best-practices, webapp-testing, web-design-guidelines, tdd |
| `ui-reviewer` (added 2026-10-08, Phase 4a) | read-only, no files | exit gates of public-site phases, after `qa-security-reviewer` | frontend-design, web-design-guidelines, playwright-best-practices |
| `code-reviewer` | read-only, no files | every file change, via the hook (ADR 0014) | security-and-hardening, next-best-practices |

Rules shared by all agents:
- Read `CLAUDE.md`, `doc/tasks.md`, `doc/decisions/README.md` and relevant ADRs first.
- Installed Next.js docs (`node_modules/next/dist/docs/`) beat skills and memory.
- Stay inside owned paths; request cross-area changes in the report.
- Never edit `doc/tasks.md` or write ADRs; propose decisions in the report. The main session (orchestrator) owns both, so parallel agents never conflict on them.
- Never push; commit only when the orchestrator says so. Parallel agents run in separate git worktrees.
- Fixed report format ending with tests run (real output), proposed decisions and open issues.

All skills are now installed up front at project scope (`.claude/skills/`, recorded in `skills-lock.json`).

Rejected skills:
- `mattpocock/skills@code-review` — shadows the built-in `/code-review`, depends on that author's setup, and spawns its own sub-agents (subagents cannot). Snyk: High Risk.
- `vercel-labs/agent-skills@deploy-to-vercel` — its script uploads a tarball of the repo to a shared anonymous endpoint (`claude-skills-deploy.vercel.com`). Not acceptable for a client repo with secrets. Deploys go through the client's linked Vercel project only.

## Consequences
- Each phase: orchestrator plans → parallel builder agents in worktrees → `qa-security-reviewer` gates → orchestrator merges, ticks `doc/tasks.md`, writes ADRs from proposals.
- A new agent or skill change = update this ADR (or supersede it) and `.claude/agents/`.
