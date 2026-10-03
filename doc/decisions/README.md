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
| [0016](0016-cloudinary-url.md) | Single `CLOUDINARY_URL`; next/image allowed only for our cloud | Accepted |
| [0017](0017-better-auth.md) | Better Auth (not Auth.js); one shared `mongodb` driver copy | Accepted |
| [0018](0018-database-connection.md) | One MongoClient for Mongoose + Better Auth; strict Mongoose; explicit indexes; URI names the DB | Accepted |
| [0019](0019-models.md) | Mongoose models: fixed spec keys, strict schemas, read-only users, whistleblower privacy limits | Accepted |
| [0020](0020-per-email-rate-limit.md) | Per-email limiter: HMAC keys, atomic fixed window, fail closed; lockout risk + mitigations | Accepted |
| [0021](0021-email-sender.md) | Resend email sender: lazy client, escaped templates, link validation, leak-free errors | Accepted |
| [0022](0022-sign-in-limits-network-device.md) | Sign-in limits: per network (HMAC'd IP), per-email slow-down, known-device cookie | Accepted |
| [0023](0023-auth-implementation.md) | Better Auth implementation: lazy init, disabled paths, no IP on sessions, hashed limiter keys, device epoch | Accepted |
| [0024](0024-permissions-and-auth-interrupts.md) | `lib/permissions.ts` access rules (fail closed, temp password unlocks nothing); `forbidden()` via `authInterrupts` | Accepted |
| [0025](0025-seed-admin-cli.md) | `seed:admin` CLI: create / reset admin, password never in argv or files, reset ends sessions + unbans + bumps device epoch | Accepted |
