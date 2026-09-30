# Decision records

One file per decision, numbered in order (`NNNN-short-title.md`). Never rewrite an accepted decision; add a new one that supersedes it and update the status line of the old one.

Template:

```
# NNNN — Title
- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```

| # | Decision | Status |
|---|---|---|
| [0001](0001-datasheets-collection.md) | Separate `datasheets` collection, products reference `datasheetId` | Accepted |
| [0002](0002-restricted-specs-and-caching.md) | Restricted specs render only in an uncached dynamic block | Accepted |
| [0003](0003-geo-block-env-only.md) | Geo-block toggled by `GEO_BLOCK_ENABLED` env only | Accepted |
| [0004](0004-rate-limiting-mongodb.md) | Login rate limit with a MongoDB TTL counter | Accepted |
| [0005](0005-whistleblower-encryption.md) | AES-256-GCM with key versioning for whistleblower data | Accepted |
| [0006](0006-search-atlas.md) | Atlas Search in every environment, regex fallback | Accepted |
| [0007](0007-proxy-ts.md) | Use `proxy.ts` (Next.js 16+) | Accepted |
| [0008](0008-caching.md) | Next.js tag-based cache for public catalog data | Accepted (API confirmed, Next 16.3.7) |
| [0009](0009-r2-private-storage.md) | Cloudflare R2 for private files | Accepted |
| [0010](0010-testing.md) | Vitest + Playwright | Accepted |
| [0011](0011-tooling-and-secrets.md) | npm, dependency list, secrets handling | Accepted |
| [0012](0012-agent-skills.md) | Agent skills: core now, rest per phase | Partly superseded by 0013 |
| [0013](0013-subagents.md) | Project subagents in `.claude/agents/` (6 builders/reviewers + hook-run code-reviewer), all skills installed up front | Accepted |
| [0014](0014-automatic-file-review-hook.md) | Automatic per-file review via PostToolUse + FileChanged hooks | Accepted |
| [0015](0015-free-security-tooling.md) | Dependabot, npm audit, gitleaks (CI + pre-commit); CodeQL skipped | Accepted |
