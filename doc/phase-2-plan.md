# Phase 2 — Admin core: implementation plan

## Context
Phase 1 (foundations) is merged to `main` (PR #9). Phase 2 builds the `/admin` panel the client uses to manage the catalog: categories, areas, products with images, datasheets, and settings. Nothing in Phase 2 is public-facing; it produces the data that Phases 3–4 import and display.
**Exit criterion:** one full product, built by hand, with images and an attached datasheet.
**State today:** `src/app/admin/{layout,page}.tsx` are placeholders that call `requireAdmin()`; shadcn is not initialised; `src/lib` has no `storage.ts`, `cloudinary.ts`, revalidation helper, audit helper or slug helper. Models (`product`, `category`, `area`, `datasheet`, `siteContent`, `auditLog`) already exist. All three external services (MongoDB, Cloudinary, R2) were verified working with `npm run check:services`.

## Decisions already made (user, 2026-10-06)
1. **Direct uploads, server verifies.** The browser uploads straight to Cloudinary (signed) and R2 (presigned PUT). Reason: Vercel rejects request bodies over about 4.5 MB, and datasheets go up to 10 MB. The server re-checks every file after upload. This amends ADR 0009 (new ADR).
2. **ADR 0019 defaults:** a draft product may have zero variants; `family` and `modelCode` optional; `modelNo` only trimmed; categories two levels (main + sub, a named constant). **Publish** (not draft) requires ≥1 variant, a main category and ≥1 image.

## Assumptions to veto at approval (cheap to change)
- Product slug stays editable after publish, with a warning (URLs change; redirects come in Phase 4).
- Areas: create, edit and delete, delete blocked while products use the area.
- Product delete is a hard delete behind a confirm dialog, with an audit entry.
- Audit policy: write first, then the audit entry. If the audit write fails, the action reports an error and logs it. Not atomic, so it needs one line in the ADR.
- Image limits: 10 MB, jpg/png/webp/avif. Image reorder uses up/down buttons (no drag-and-drop library, no motion).
- R2 lifecycle rule (delete `incoming/` after 1 day) plus a manual sweep script as a backstop.

## Step 0 (first action of the new session, before any task)
This plan file lives outside the repo. Copy it to `doc/phase-2-plan.md`, rewrite "▶ Resume here" in `doc/tasks.md` to point at it (next task = T1), and commit on `phase-2`.

## Architecture (applies to every task)
**Three layers per entity**
- `src/lib/schemas/<entity>.ts`: pure Zod 4 schemas, no `server-only`. Used by React Hook Form (`zodResolver`) on the client and re-parsed on the server (rule 8).
- `src/lib/admin/<entity>.ts` (`import "server-only"`): services `createX/updateX/deleteX`. Each awaits `connectDb()`, re-parses with Zod, writes, writes the audit entry, and returns `{ok, data | errors, tags}`. Services never call `updateTag` (it throws outside a Server Action).
- `src/app/admin/<module>/actions.ts` (`"use server"`): thin. Statement one is `const { viewer } = await requireAdmin()`; then the service with `viewer.user.id`; then `revalidateCatalogInAction(tags)`; `redirect()` only after that, outside any `try`. Never wrap `requireAdmin`/`redirect` in try/catch without `unstable_rethrow` (ADR 0024).
- Every admin `page.tsx` and `layout.tsx` also calls `requireAdmin()` at the top, outside Suspense (layouts don't re-run on client navigation, ADR 0029).

**Shared helpers (created in T2)**
- `src/lib/revalidate.ts`: typed tags (`products`, `product:<id>`, `categories`, `areas`, `settings:columns`, `datasheets`); `revalidateCatalogInAction` uses `updateTag`; `revalidateCatalogFromRoute` uses `revalidateTag(tag, "max")` (ADR 0008). `cacheComponents` stays off until Phase 4, so Phase 2 can only unit-test it.
- `src/lib/audit.ts`: `recordAudit({actorId, action, target, meta})`. Action vocabulary is a const union `<entity>.<verb>`: `product.create|update|delete|publish|unpublish|images.update`, `product.datasheet.attach|detach`, `category.create|update|delete|reorder`, `area.create|update|delete|reorder`, `datasheet.upload|replace|delete`, `settings.columns.update|whatsapp.update|email.update`. `meta` holds ids, changed field names and counts only — never the WhatsApp number, email, or restricted spec values. Rejects meta over 4096 bytes.
- `src/lib/slug.ts` (`slugify`, `uniqueSlug`), `src/lib/constants.ts` (`MAX_CATEGORY_DEPTH = 2`, `MAX_DATASHEET_BYTES`, `MAX_IMAGE_BYTES`, upload folders), `src/lib/utils.ts` (`cn`, from shadcn).

**Uploads (all through Server Actions; no new Route Handlers)**
- Cloudinary: `signCloudinaryUpload({productId, kind})` returns `{cloudName, apiKey, timestamp, signature, folder, public_id, allowed_formats}`. The `public_id` is server-chosen (`yg/products/<productId>/<uuid>`), signed with `cloudinary.utils.api_sign_request`. The signed API cannot cap size, so the client checks ≤10 MB and `saveProductImages` verifies afterwards: it accepts only ids matching `^yg/products/<id>/[0-9a-f-]{36}$`, calls `cloudinary.api.resource`, checks `bytes`/`format`, and destroys + rejects a bad one.
- R2 datasheets: `presignDatasheetUpload({fileName, size})` returns a presigned PUT for `incoming/<uuid>.xlsx` (5-minute TTL, signs `ContentType` and `ContentLength`). `finalizeDatasheet({incomingKey, mode: new|replace, datasheetId?, fileName})`: validate the key regex → `HeadObject` size → `GetObject` into a buffer (≤10 MB) → magic bytes `PK\x03\x04` → JSZip checks `[Content_Types].xml` and `xl/workbook.xml` exist (read only those entries, cap entry count at about 2000, never inflate everything) → `CopyObject` to `datasheets/<uuid>.xlsx` (or the existing `storageKey` when replacing) → delete the incoming object → write Datasheet doc → audit → return tags. Any failure deletes the incoming object (best effort) and returns a generic error.
- CSP: `connect-src` gains `https://api.cloudinary.com` and `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` **for `/admin/:path*` only**. `buildCsp`/`securityHeaders` get an `extraConnectSrc` option; `next.config.ts` adds a `/admin/:path*` headers entry reading `process.env.R2_ACCOUNT_ID` like `cloudinaryImagePatterns` does. **Verify in the installed Next docs that a later matching headers entry overrides an earlier one for the same key**, and test it (public CSP unchanged, admin CSP gains exactly two hosts). Append a note to ADR 0027.
- Server Action body limit stays at the 1 MB default (uploads bypass the server); Zod caps on array and string lengths guard pathological forms.

**Auth-guard tests (two layers)**
- Static `test/admin-guards.test.ts` (same style as `test/repo-security.test.ts`): every `src/app/admin/**/{page,layout}.tsx` calls `requireAdmin()`; every exported action in `actions.ts` calls it before any other awaited statement; every exported action calls the audit helper and the revalidate helper (added at T15).
- Behavioural, per actions file: call each exported action as a **customer** and as a **visitor** (reuse the session mocking from `src/lib/permissions.test.ts`; extract to `test/helpers/admin-session.ts`); assert it throws/redirects and DB counts are unchanged (QA L2, task 6).

**ESLint:** add `no-restricted-imports` so `"use client"` files cannot import `server-only` modules or `src/lib/admin/*`.

## Tasks (one commit each; typecheck + lint + tests green; tasks.md "Resume" rewritten before each commit)
Models: **O** = Opus 5.5 (security/logic), **S** = Sonnet 5.5 (routine UI). Owners follow `.claude/agents` rules: `backend-architect` owns `src/lib`, `src/models`, `src/app/api`, `scripts`, config; `admin-panel-builder` owns `src/app/admin`, `src/components/admin`, `src/components/ui`; the main session alone edits `doc/` and CLAUDE.md and writes ADRs (subagents hand it ADR text).

| # | Task | Owner / model | Key files | Tests |
|---|---|---|---|---|
| T1 | shadcn init, map tokens onto ink/paper/grey (no dark mode, strip animation classes). Create `.claude/reviews/.disabled` first, **remove it at the end** | admin-panel-builder / S | `components.json`, `src/lib/utils.ts`, `src/components/ui/*` (button, input, label, textarea, select, checkbox, switch, table, dialog, alert-dialog, dropdown-menu, badge, card, tabs, skeleton, separator), `globals.css` | globals.css contrast QA test stays green; add pairs for primary button + muted text. ADR: shadcn adoption and token mapping |
| T2 | Shared building blocks + `products.datasheetId` index | backend-architect / O | `src/lib/{revalidate,audit,slug,constants}.ts`, `src/models/product.ts`, `db-indexes` | `revalidate.test.ts` (mock `next/cache`), `audit.test.ts` (memory DB: oversize/unknown action rejected), `slug.test.ts`, `db-indexes.test.ts`. ADR: admin write path |
| T3 | Admin shell, sidebar nav (server component, skip link, active link via a tiny client component, mobile `<details>` menu), dashboard counts | backend-architect (`src/lib/admin/dashboard.ts`, `getCounts()` with parallel `countDocuments`, no cache) then admin-panel-builder / S | `src/app/admin/{layout,page,loading,error}.tsx`, `src/components/admin/admin-nav.tsx` | `getCounts` on memory DB; extend guard test; fix placeholder e2e text |
| T4 | Category schemas + service: depth ≤ `MAX_CATEGORY_DEPTH`; parent must be top-level; slug unique per parent; move up/down swaps `order`; delete blocked if children or products reference it (`mainCategory`/`extraCategories`) | backend-architect / O | `src/lib/schemas/category.ts`, `src/lib/admin/categories.ts` | schema + service tests (depth, in-use block, audit, tags) |
| T5 | Categories tree editor UI (nested list, edit, move, AlertDialog delete) | admin-panel-builder / S | `src/app/admin/categories/*`, `src/components/admin/category-{tree,form}.tsx` | actions as customer + visitor; form test |
| T6 | Areas module (backend then UI; split T6a/T6b if large): create/edit/delete, `bwImage` as publicId text for now (uploader added in T11), delete blocked while used | both / O then S | `src/lib/{schemas,admin}/area*.ts`, `src/app/admin/areas/*` | as T4/T5. **QA gate A** (T1–T6) |
| T7 | Product Zod schemas: strict, 28 `SPEC_KEYS`, numeric filters, https-only `publicFiles`, unique `modelNo` within the form, caps on lengths; separate `publishCheck()` (≥1 variant, main category, ≥1 image) | backend-architect / O | `src/lib/schemas/product.ts` | schema tests, `publishCheck` cases |
| T8 | Product service: `listProducts({q,status,category,page})` (25 per page, `q` ≤80 chars and regex-escaped, lean projection), `getProductForEdit`, `createDraft`, `updateProduct`, `publish/unpublish`, `deleteProduct` (document only; images swept later); duplicate `modelNo` from the partial unique index becomes a field error | backend-architect / O | `src/lib/admin/products.ts` | memory DB: pagination, search, duplicate `modelNo`, publish refusal, audit, tags |
| T9 | Products list + "new draft" (name + main category → redirect to edit page, giving uploads a stable id) | admin-panel-builder / S | `src/app/admin/products/{page,new/page,actions}.tsx`, `products-table.tsx` | actions as customer + visitor; empty/error states |
| T10a/b | Product edit form: (a) basics, categories, areas, filters; (b) specs editor grouped from `SPEC_COLUMNS`, variants (`useFieldArray`), extra specs, public files. Client sends JSON, server re-parses | admin-panel-builder / S | `src/app/admin/products/[id]/*`, `src/components/admin/product-form/*` | action as customer + visitor; field-error mapping; render test. **QA gate B** |
| T11a | Cloudinary lib + sign/verify services + CSP/next.config change | backend-architect / O | `src/lib/cloudinary.ts` (explicit `cloudinary.config` from `env.cloudinary()`, ADR 0016), `src/lib/security-headers.ts`, `next.config.ts` | signature test with fixed secret/timestamp; public_id regex; mocked `api.resource` rejection; CSP tests. ADRs: direct uploads (amends 0009), note on 0027 |
| T11b | Images editor UI: file input, 10 MB client check, direct POST with progress text, required alt text, kind select, up/down reorder (action takes the full ordered `publicId[]`, idempotent); also the areas uploader | admin-panel-builder / S | `product-form/images-editor.tsx`, actions | customer + visitor tests |
| T12 | Storage lib + xlsx signature check + datasheet service (replace keeps `storageKey`; delete blocked while any product uses it; R2 object deleted before the doc) | backend-architect / O | `src/lib/{storage,xlsx-signature}.ts`, `src/lib/schemas/datasheet.ts`, `src/lib/admin/datasheets.ts` | signature tests (valid xlsx built with exceljs, renamed .zip, renamed .txt, truncated zip, oversized, too many entries); service tests with a fake storage module (incoming deleted on every failure, replace keeps key, delete blocked, attach to many) |
| T13 | Datasheets UI: list with in-use count, uploader (presign → PUT → finalize), picker in the product form; never a public URL | admin-panel-builder / S | `src/app/admin/datasheets/*`, `datasheet-uploader.tsx`, `product-form/datasheet-picker.tsx` | customer + visitor tests with the storage mock showing no calls. **QA gate C** |
| T14 | Settings service: `columnVisibility` (28 keys), `whatsappNumber` (digits, normalised), `companyEmail`; defaults from `SPEC_COLUMNS`; saving columns returns tags `settings:columns` + `products`, and a column newly made restricted also clears its filter on all products (`updateMany`) | backend-architect / O | `src/lib/schemas/settings.ts`, `src/lib/admin/settings.ts` | schemas, filter cleanup, tags; audit meta holds no number/email |
| T15 | Settings UI (switch per column, restricted defaults labelled; no geo-block switch, ADR 0003) | admin-panel-builder / S | `src/app/admin/settings/*` | customer + visitor tests. Static test: every action calls audit + revalidate. **QA gate D** |
| T16 | Publish/unpublish with `publishCheck` reasons; `loading/error/not-found` for each segment | admin-panel-builder / S | product edit page | reasons-list test |
| T17 | Orphan scripts: `scripts/sweep-incoming.ts` (>24 h), `scripts/sweep-cloudinary-orphans.ts` (dry-run default, `--apply`), list-only report of orphaned `datasheets/` objects | backend-architect / O | `scripts/*`, `package.json` | selection-logic unit tests with a fake storage |
| T18 | Exit e2e: sign in → category + area → product with variants/specs/images → xlsx datasheet → attach → publish → listed as published. Stub browser calls to Cloudinary/R2 with `page.route`, and swap server-side storage/Cloudinary for a fake through an env switch in `e2e/test-server.ts` | admin-panel-builder / S | `e2e/admin-product.spec.ts` | Use `http://localhost`, never `networkidle`. **QA gate E** (Phase 2 exit, `qa-security-reviewer` on Opus) over the whole branch |

After QA E passes: main session writes the final ADR notes, ticks Phase 2, rewrites Resume (next = Phase 3), pushes, opens the PR with `gh`, waits for CI, and **asks the user before merging**.

## Things the user must do (tell them in the new session)
- **Before T11/T12:** apply this CORS rule once to the R2 bucket (Cloudflare → R2 → bucket → Settings → CORS), adding the production domain at deploy time:
  `[{"AllowedOrigins":["http://localhost:3000"],"AllowedMethods":["PUT"],"AllowedHeaders":["content-type","content-length"],"MaxAgeSeconds":600}]`
- Optional: R2 lifecycle rule, prefix `incoming/`, expire after 1 day.
- Atlas non-SRV `MONGODB_URI` is already in place; keep the VPN-proof string.
- The `scripts/check-services.ts` / `npm run check:services` tool is **uncommitted**; commit it in Step 0.

## Risks
- Cloudinary signed uploads can't cap size; the post-upload `api.resource` check is essential.
- A partial failure (R2 copy succeeds, DB write fails) leaves an orphan under `datasheets/`; T17 reports these (list-only).
- Replacing a datasheet overwrites in place; a concurrent download could be inconsistent. Acceptable until Phase 5 serves presigned GETs.
- `updateTag` throws outside Server Actions, so services only return tags.
- shadcn CLI needs network and may add animation classes; T1 strips them and pauses the review hook only for T1.
- Larger product form: split T10 into a/b, as above.

## ADRs to write (main session; numbers from 0034)
1. shadcn adoption and token mapping. 2. Admin write path (services, audit vocabulary, revalidation, non-atomic audit). 3. Direct uploads and orphan handling (amends 0009). 4. Appended note on ADR 0027 (admin-only connect-src). 5. Admin product rules (publish check, depth constant, delete blocks, filter cleanup on restricted columns).

## Verification
- Per task: `npm run typecheck`, `npm run lint`, `npm test`.
- Exit: `npm run db:indexes` on a scratch DB (the `products.datasheetId` index is built); `npm run build`; `npm run test:e2e`; response headers on `/admin` show exactly the two extra `connect-src` hosts and `/` is unchanged; manual smoke with the real credentials — build one full product with images and a datasheet, confirm the `incoming/` object is gone and the key is under `datasheets/`; a customer gets 403 and a visitor is redirected on every admin URL.
- QA gates: A after T6, B after T10, C after T13, D after T15, E at exit.

## Model guidance for the new session
Use **Opus 5.5** for T2, T4, T6a, T7, T8, T11a, T12, T14, T17 and every `qa-security-reviewer` run; **Sonnet 5.5** for the UI tasks (T1, T3 UI, T5, T6b, T9, T10, T11b, T13, T15, T16, T18).
