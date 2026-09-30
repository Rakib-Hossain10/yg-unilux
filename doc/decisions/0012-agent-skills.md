# 0012 — Agent skills
- Status: Partly superseded by 0013 (all skills now installed up front; `deploy-to-vercel` rejected)
- Date: 2026-09-30

## Context
Skills found with `find-skills` (`npx skills find`), chosen by install count and source reputation. Installing everything up front would bloat every session's context.

## Decision
Install per phase, project scope, committed (`npx skills add <owner/repo@skill> -y`). Read each SKILL.md before first use.

| Phase | Skills |
|---|---|
| 0 | `vercel-labs/agent-skills@vercel-react-best-practices`, `@vercel-composition-patterns`; `vercel-labs/openreview@next-best-practices`, `@next-cache-components`; `mongodb/agent-skills@mongodb-connection`; `addyosmani/agent-skills@security-and-hardening` |
| 2 | `shadcn-ui/ui@shadcn` |
| 4 | `vercel-labs/agent-skills@web-design-guidelines`; `anthropics/skills@frontend-design`, `@webapp-testing` |
| 6 | `greensock/gsap-skills@gsap-core`, `@gsap-scrolltrigger`, `@gsap-react`, `@gsap-timeline`, `@gsap-performance`; `vercel-labs/agent-skills@vercel-react-view-transitions` |
| 9 | `addyosmani/web-quality-skills@seo` |
| 10 | `vercel-labs/agent-skills@deploy-to-vercel` |

Already installed: `vercel-labs/skills@find-skills`.

## Consequences
- Skills are guidance only; installed Next.js docs and CLAUDE.md rules win on any conflict.
