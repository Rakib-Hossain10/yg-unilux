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
| [0054](0054-product-page-spec-placement.md) | Product page: the client's pink columns go in a right-side quick-spec panel, green columns in the full spec table; `placement` in `SPEC_COLUMNS`; visibility still wins (Phase 4) | Accepted |
| [0055](0055-case-insensitive-model-no.md) | Case-insensitive model nos.: collated unique index (en/2), shared `modelNoKey`, collation on every lookup, duplicate-key re-read, server-owned `sourceSha256`, manual index migration + `check:model-nos` | Accepted |
| [0056](0056-import-cleaning-and-parsing.md) | Import cell cleaning (NFKC, blank-line cut, CJK strip, n/a tokens, per-column split policy) and unit-aware filter parsers; restricted filters dropped later by the plan step | Accepted |
| [0057](0057-import-pipeline.md) | Import pipeline: stateless preview (writes nothing) + `planHash` re-checked at commit, ETag-pinned staged file, case-insensitive matching with cross-product conflicts, field-ownership merge, Zod on every record, restricted filters gated by `withoutRestrictedFilters`, sheet guard / one zip path / reader, grouping and picture rules | Accepted |
| [0058](0058-import-ui.md) | Import UI: one page with three client steps, thin actions (presign/preview/commit/finish), shaped preview without merged values, browser-driven batch loop with retry / preview-again, removal checkbox, labels for every warning code, `maxDuration` 300 | Accepted |
| [0059](0059-controlled-import-template.md) | The controlled import template is the primary input: generated per download from the DB, English headers with rule notes, strict dropdowns (Category, Extra Category 1–2, one Yes/No column per area) from a hidden Lists sheet; the tolerant parser stays as the safety net; T10 runs next | Accepted |
| [0060](0060-import-staging-and-server-image-upload.md) | Import staging in R2 (`imports/<uuid>.xlsx`, signed type + length, capped ETag-pinned read, 24 h sweep) and server image upload checked on the Upload API answer instead of `inspectImage`; audit `import.commit` | Accepted |
| [0061](0061-import-commit.md) | Import commit: per-entry hashes + `sheetHash` (hash v2) so batches can resume, 20-product batches, conditional updates of sheet-owned paths only, picture keep/destroy rule, one audit entry per writing batch | Accepted |
| [0062](0062-catalog-caching-mode.md) | Catalog caching without `cacheComponents` (it costs the real admin 403): `unstable_cache` + tags, ISR product pages, restricted block fetched from a `private, no-store` route | Accepted |
| [0063](0063-catalog-data-layer.md) | Catalog data layer: plain view model, inclusion projection from column visibility (+ second key filter), tags `products`/`areas`/`settings:columns`/`categories`, drafts null, `getRestrictedSpecs` checks the viewer before reading and is guarded by a static test | Accepted |
| [0064](0064-product-page-structure.md) | Product page: no `loading.tsx`, JSON-LD shape, `?model=` read after hydration + `replaceState`, rows shown if any variant fills them, gallery/lightbox rules, restricted block fetched from a `no-store` route (coming-soon first, banned → expired, temporary password → sign in), reserved slot heights | Accepted |
| [0065](0065-listing-data-layer.md) | Listing data layer: path for category, bounded query params, main-or-extra subtree scope, OR-within/AND-across filters, three restricted-facet guards, normalised cache keys, no page-past-end entries | Accepted |
| [0066](0066-catalog-search.md) | Catalog search: `products_search` Atlas index (public fields, `db:search-index` script), boosted compound with a published filter, escaped-regex fallback only on throw and never cached, `private, max-age=30` route, `matchedModelNo` deep links | Accepted |
| [0067](0067-category-icon-cover.md) | Category icon (Cloudinary id, SVG allowed but always delivered raster, never inline), optional cover + plain-text description, `category` upload target, sweep folders derived from upload folders, `CATALOG_CACHE_VERSION` v3 | Accepted |
| [0068](0068-account-flows-and-invites.md) | Account flows: invite = 72 h Better Auth reset token (one live link per user, regenerate kills the rest), `passwordSetAt`/`invitedAt`/`inviteExpiresAt`/`expiryReminderFor` fields, one user-field writer, after-hooks clear `mustChangePassword` + 24 h cap (closes 0032 gap), `safeNextPath`, e2e email sink | Accepted |
| [0069](0069-access-requests.md) | Access requests: plain-charset fields + consent, honeypot + 3 s fill + net 5/15 min + email 3/day, one pending per email (partial unique index, latest wins, never into WhatsApp/linked rows), identical answers, claim released only before the account write | Accepted |
| [0070](0070-customers-module.md) | Customers: users written only via Better Auth or `account-writes`, status model with invite `$expr`, end-of-UTC-day expiry math, no hard delete, temp password shown once, invite regenerate limits + owner-token lock, `auditFailed` keeps one-time credentials | Accepted |
| [0071](0071-datasheet-download-route.md) | Datasheet download: 404 product checks before the session, shared access rule → login/renew 303s, row check after access, 60/h per-user limit (admin exempt), presign only `datasheets/<uuid>.xlsx` keys for 60 s with RFC 5987 name, log before redirect (fail closed 503), `private, no-store` everywhere, only the route imports `presignGet` | Accepted |
| [0072](0072-access-expiry-cron.md) | Access-expiry cron (amended: no reminder before the invite is accepted): SHA-256 + `timingSafeEqual` Bearer check, customers due in `now < expiry ≤ now + 7 d` with `expiryReminderFor ≠ accessExpiresAt`, marked after send via `account-writes`, global lock + Resend idempotency keys, 240 s budget, digest of the customers reminded in the run, counts-only body and audit, daily 08:00 UTC, dry-run CLI by default | Accepted |
| [0073](0073-admin-actor-check-prefetch-safe-next.md) | QA gate A fixes: every admin customers/access-request service checks the actor from the DB session first (`refuseUnlessAdmin`/`assertAdminActor`, `denied` reason → `forbidden()`), AST guard test; approve withholds the invite for blocked customers; datasheet route answers prefetch with 204 and HEAD with 405; `safeNextPath` refuses dot segments and `//` pathnames | Accepted |
