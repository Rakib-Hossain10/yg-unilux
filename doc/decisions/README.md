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
| [0026](0026-proxy-geo-block-403.md) | Proxy answers CN with its own 403 page (rewrite loses the status); malformed `GEO_BLOCK_ENABLED` fails closed; matcher skips only `_next/static` + favicon | Accepted |
| [0027](0027-security-headers-csp.md) | Security headers; static CSP with inline scripts allowed (nonces would make every page dynamic; SRI tested and fails on inline flight scripts) | Accepted |
| [0028](0028-design-shell.md) | Design shell: Cormorant Garamond + Inter via next/font, warm-grey tokens, `(site)` group with SiteShell, shared 404/403/error pages | Accepted |
| [0029](0029-login-admin-placeholder-e2e.md) | `/login` posts to `/api/auth` (method=post), `/admin` guarded in layout + page, e2e on a seeded in-memory replica set | Accepted |
| [0030](0030-auth-responses-tokens-aborts.md) | Auth JSON answers carry no session token; client aborts are a quiet 499; e2e server blanks every `.env.example` variable | Accepted |
| [0031](0031-change-password-per-user-limit.md) | `/change-password` limited to 5 per user per 15 min (HMAC'd user id), checked before the password | Accepted |
| [0032](0032-keep-me-signed-in.md) | "Keep me signed in" checkbox, off by default, same for every role (unchecked: browser-session cookie, 24 h server cap) | Accepted |
| [0033](0033-blocking-audit-allowlist.md) | Full-tree `npm audit` is blocking via `scripts/audit.mjs` with a dated allowlist (only GHSA-vfj7-8cjw-p6xm, review by 2027-01-05) | Accepted |
| [0034](0034-shadcn-tokens.md) | shadcn (radix-nova, `radix-ui`) mapped onto ink/paper/grey tokens; new `--color-danger`; light only; animation classes stripped and enforced by test | Accepted |
| [0035](0035-admin-write-path.md) | Admin write path: schemas → services (return tags) → thin actions; one audit vocabulary (schema enum + Zod); meta = ids/field names/counts; typed tags, `settings:columns` expired at once; non-atomic audit | Accepted |
| [0036](0036-admin-shell.md) | Admin shell: layout guard gives the real 403 (loading.tsx doesn't wrap it), page guard for client nav; static-only admin metadata; static guard test; `<details>` mobile nav | Accepted |
| [0037](0037-category-service.md) | Category service: shared result module, tags per write, no-op writes, renumbering move, generic depth, slug rules | Accepted |
| [0038](0038-admin-action-ui-pattern.md) | Admin action/form UI pattern: callAction + ActionResult, notices, aria-disabled edges, actions.ts guard rules | Accepted |
| [0039](0039-areas-module.md) | Areas module: name/slug/bwImage only, global slug, move renumbers, delete blocked by products, update also expires `products` | Accepted |
| [0040](0040-product-schema.md) | Product form schema: pure/client-safe, strict, 28 spec keys, https-only files, `publishCheck` on stored facts enforced by the T8 service | Accepted |
| [0041](0041-product-service.md) | Product service: trackSize only under Magnetic Track, publish gate on stored facts, modelNo duplicates as field errors, URL-tolerant list, tag policy | Accepted |
| [0042](0042-products-list-ui.md) | Products list UI: GET filters, draft redirect to edit page, shared `useSerialAction` move guard, notice cleared after settle | Accepted |
| [0043](0043-product-edit-form.md) | Product edit form: status only via publish/unpublish, optimistic concurrency on `updatedAt`, published stays publishable, round-trip of unedited fields, route groups for a real 404 | Accepted |
| [0044](0044-product-form-rows-and-specs.md) | Product form (b): specs one option per line, UI spec groups, one generic row-list editor, errors placed only on unchanged rows, no input `name`s | Accepted |
| [0045](0045-direct-uploads.md) | Direct uploads, server verifies (amends 0009): server-chosen ids, signed `overwrite=false`, post-upload `api.resource` check, removed images kept for the orphan report; admin-only `connect-src` (note on 0027) | Accepted |
| [0046](0046-images-editor-ui.md) | Images editor UI: own section and Save (not in a form), sequential XHR upload with `public_id` echo check, previews from `res.cloudinary.com`, error placement, variant image select, area uploader | Accepted |
| [0047](0047-datasheet-service.md) | Datasheet storage + service: path-style R2 presigned PUT, own zip central-directory check (entry cap, capped inflate, workbook content type), incoming always deleted, replace keeps key, delete R2-first and blocked while in use, publish re-checks category/datasheet | Accepted |
| [0048](0048-datasheets-ui.md) | Datasheets admin UI: XHR PUT with exact headers, list search/paging in the page, row rename/replace/delete, picker in the product form, publish errors mark inputs | Accepted |
| [0049](0049-settings-service.md) | Settings service: siteContent keys, 28-key strict visibility form that fails closed on read, filter cleanup for newly restricted columns, digits-only WhatsApp, value-free audit meta | Accepted |
| [0050](0050-settings-ui.md) | Settings UI: two cards, retry stays enabled after a failed filter cleanup, static guard requires revalidate + service call, restricted filters dropped on product save | Accepted |
| [0051](0051-orphan-sweep-scripts.md) | Orphan sweep scripts: pure selection, dry-run default, 24 h window, Cloudinary products/areas only, list-only datasheet report | Accepted |
| [0052](0052-e2e-provider-fakes.md) | E2E: in-memory R2/Cloudinary fakes via a preload on `next start`, shared sign-in state, one worker, `admin-exit` project last | Accepted |
| [0053](0053-sweep-guard-etag-finalize.md) | Sweep mass-delete guard (`--max-delete`, names printed) and ETag-pinned datasheet finalize (gate E M-1, L-1) | Accepted |
