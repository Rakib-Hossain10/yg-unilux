# YG UniLUX — Catalog Website

Premium lighting-product catalog for YG UniLUX (commercial lighting manufacturer).
500+ products, public catalog + admin panel + restricted Excel datasheets.
Visitors from mainland China are blocked (Hong Kong, Macau, Taiwan are allowed).
English only — no i18n library, no language switcher, no `[locale]` routes.

## Stack
- Next.js (App Router) + TypeScript, Tailwind CSS, shadcn/ui (admin)
- Motion: GSAP + ScrollTrigger, Lenis smooth scroll, Motion (Framer Motion)
- MongoDB Atlas + Mongoose 9 + the official `mongodb` driver pinned to Mongoose's own range (`~7.6`) so there is ONE driver copy (ADR 0017; a test enforces it)
- Auth: Better Auth (ADR 0017) — email/password only with `disableSignUp`, admin plugin (roles `admin`/`customer`, `createUser`, `banUser`, `setUserPassword`), MongoDB adapter on Mongoose's connection, database sessions, argon2id, reset emails via Resend, telemetry off. Read the installed `better-auth` docs/types before writing auth code.
- Cloudinary — public product images only
- Private files (.xlsx datasheets, whistleblower attachments): Cloudflare R2 private bucket, presigned URLs, always through `src/lib/storage.ts` (ADR 0009)
- Resend (email), MongoDB Atlas Search (Atlas in every environment, regex fallback only if `$search` fails — ADR 0006), React Hook Form + Zod
- Vercel Cron for the daily access-expiry reminder job
- Hosting: Vercel (+ Vercel Firewall for geo-block)
- Tooling: npm ≥ 12.1 (`devEngines` warns on older npm; Node 22 ships npm 10, so run `npm i -g npm@12` first; CI pins 12.1.0), Node ≥ 22, Vitest (+ mongodb-memory-server), Playwright, ESLint, Prettier, husky + lint-staged (ADR 0010, 0011)
- Versions: Next.js 16.3.7, React 19.2, TypeScript 5.9, Tailwind 4, Mongoose 9, Zod 4. The Next.js docs for this version are in `node_modules/next/dist/docs/`; read them before using any Next API.
- Security tooling (all free): Dependabot, `npm audit --audit-level=high` in CI, gitleaks in CI + pre-commit; no CodeQL (ADR 0015)

## Folder structure
```
src/
  app/
    (site)/          home, products, areas, product/[slug], services, oem-odm, rnd, about, contact, legal
    (account)/       login, change-password, my-downloads
    whistleblower/   report form, inbox
    admin/           dashboard + admin modules
    api/             datasheet download, uploads, auth, import, cron
    blocked/         page shown to mainland China
  components/        ui/ (shadcn), site/, admin/, motion/
  lib/               env, db, auth, cloudinary, storage, email, geo, permissions, rate-limit, crypto, catalog, import
  models/            one Mongoose schema per collection
  proxy.ts           geo-block + coarse admin redirect (Next.js 16 name for middleware — ADR 0007)
scripts/             seed-admin and other CLI scripts
e2e/                 Playwright tests
doc/                 tasks.md (tracker) + decisions/ (ADRs)
```

## Domain model
- Two independent browse dimensions:
  - **Categories** = product type. Tree (`parent` null = main category). ~10 main categories.
  - **Areas** = application (7): Residential, Retail, Hospitality, Office, Healthcare, Education, Exhibition.
- Product has `mainCategory`, `extraCategories[]` (same product can appear under e.g. Spot Lights→Recessed AND Recessed Lights→Spot), and `areas[]`.
- Category tree lives in the DB and is edited in the admin panel (7 main categories known now, 3 more coming — never hard-code the list).
- Magnetic Track subcategories: 5mm, 10mm, 20mm, GOBO, Linear, Decorative. Products there also carry `trackSize` (5 | 10 | 20) used as a listing filter.
- Product data follows the client's spec sheet (33 columns, headers "English\nChinese"). Three levels:
  - **Family** = `Model Name` (e.g. "Arc") → "More from Arc" strip + family filter.
  - **Product** = one `NO.` (e.g. 76) → ONE product page. A row with an empty `NO.` belongs to the product above it.
  - **Variant** = each row / `Model No.` (e.g. AR-013A1 lens, AR-013A2 reflector) → optic switch on the page (updates model no., lumen, efficacy).
  - Slug = family + base model code, e.g. `/product/arc-ar-013a`. Every variant's model no. is searchable.
- Sheet columns: NO., Model Name, Model Type, Model No., Batch No., Image, Housing Material, Housing Color/Finish, Reflector Color, Lens, Reflector, Diffuser, Cut-out Size, Dimensions, Rotating Angle, Chip Type, Holder, Chip Efficiency, CCT, CRI, Beam Angle, UGR, Driver, Voltage Input, Wattage, Lumen Output, Lumen Efficiency, Power Factor, SDCM, Dimmable, Lifespan, IP Rating, Warranty Period.
- Column visibility is an admin setting (public / restricted). Default restricted: Batch No., Chip Type, Holder, Chip Efficiency, Driver. Restricted values are stripped on the server for anyone who is not an active, unexpired customer or the admin — never sent to the browser and hidden with CSS.
- Filters: CCT, CRI, Beam Angle, UGR, Wattage, IP Rating (+ trackSize for Magnetic Track). Store parsed numeric values alongside display strings for filtering.
- Extra product info outside the sheet goes in `extraSpecs: {group, label, value}[]`.

### Bulk import rules (admin uploads the client's sheet as-is)
- English only: keep text before the first blank line in a cell; strip CJK characters from mixed cells ("Lifud 莱福德" → "Lifud").
- Multi-line cells → option arrays (CCT "3000K\n4000K", beam "20°\n30°\n40°\n60°", finish "White/Black").
- Values equal across a product's rows → product-level specs; values that differ → variant fields.
- "-" and blank = not applicable → hidden.
- Extract embedded images by row anchor (xl/drawings) and upload to Cloudinary; admin adds more images later.
- Category and areas are not in the sheet → optional extra template columns, else assigned after import.
- Always a preview step with per-row warnings (missing specs, no image, duplicate model no.) before saving. Re-import upserts by model no.; never duplicates.
- All text is plain English strings.
- Datasheets are their own collection (ADR 0001): `datasheets` = storage key, file name, size, mime type, updatedAt, uploadedBy. Products reference it with `datasheetId`; one file can be attached to many products (e.g. a whole family sheet). Replacing a file keeps the storage key. Deleting a datasheet still used by products is blocked. Same file for every approved customer. Accept .xlsx only (check file signature, not just extension), max 10 MB. No `datasheetId` → show "Datasheet coming soon".
- Customer access: one approval unlocks ALL datasheets. `user.accessExpiresAt` is set by the admin at account creation/approval (3/6/12 months, custom date, or null = no expiry) and can be extended later. Expired → login works but downloads are locked with "Access expired — contact us". Daily cron emails customers 7 days before expiry.
- Collections (11): products, categories, areas, users, accessRequests, downloadLogs, datasheets, leaders, siteContent, whistleblowerCases, auditLog. Plus the internal `loginAttempts` (TTL, per-email rate limiting).
- Better Auth owns `users`, `sessions`, `accounts`, `verifications`, `rateLimits` (raw driver). Mongoose code never writes them; any Mongoose model over `users` is read-only. User fields we add via `additionalFields` (`input: false`): `mustChangePassword`, `accessExpiresAt`, `company`, `country`. Blocking = Better Auth `banned`/`banExpires` (replaces a custom `status`).

## Roles
Only two: `admin` and `customer` (keep the `role` field so a second admin can be added later without code changes).
- **admin** — ONE account for the client, created by a seed script (`npm run seed:admin`). Full access to everything in `/admin`, including whistleblower cases. No staff-user management screen.
- **customer** — created by the admin; front-end login + datasheet download only, no admin access.
- Single admin must never get locked out: provide an email password-reset link AND let the seed script reset the admin password from the CLI.

## Security rules — never break these
1. A datasheet .xlsx is NEVER in `/public` and NEVER behind a public URL.
2. Datasheets are served only via `/api/datasheet/[productId]`: check session (from the database) → role=customer or admin → not banned (Better Auth `banned`/`banExpires`) → `accessExpiresAt` null or in the future → resolve `datasheetId` → return a short-lived (~60 s) R2 presigned URL → write a downloadLogs entry (user, product, datasheet) → `Cache-Control: private, no-store`.
3. Every admin page AND every admin API route and server action checks the role on the server (`requireAdmin()`). Hiding a button is not access control; `proxy.ts` is never the only guard.
4. No self-registration. Accounts are created by the admin (manually or by approving an access request).
5. Passwords hashed with argon2id (Better Auth `password.hash/verify`); login and password-reset rate-limited per IP (Better Auth `rateLimit`, `storage: "database"`) AND per email (our MongoDB TTL counter, ADR 0004); public sign-up disabled (`disableSignUp`); new accounts have `mustChangePassword: true` and are redirected to change it. Admin checks and the datasheet route read the session from the database, never only from a cookie cache.
6. Geo-block: `x-vercel-ip-country === 'CN'` → rewrite to `/blocked` (403), toggled ONLY by the `GEO_BLOCK_ENABLED` env var (not an admin setting — ADR 0003). Block ONLY `CN` — never HK, MO or TW. Applies to the whole site including `/admin` (client team uses a VPN) unless told otherwise. Local dev has no country header, so it does not block locally.
7. Whistleblower: named reports = mailto the company email (`COMPANY_EMAIL` env / admin setting). Anonymous reports: never store IP (and never apply IP rate limiting on these routes), no analytics on those pages, strip EXIF from uploads with `sharp`, encrypt report text + messages at rest with AES-256-GCM and a stored `keyVersion` (key `WHISTLEBLOWER_ENC_KEY`; losing it makes data unreadable — ADR 0005); alert email to the company email contains no report content.
8. Validate every form and API input with Zod on the server.
9. Restricted spec values never appear in any cached HTML, cached data entry, shared/CDN cache, search result, family/related strip, JSON-LD, metadata or sitemap. Cached catalog queries exclude restricted fields by projection; only one uncached function reads them, rendered in a separate dynamic block (ADR 0002).
10. Secrets live in `.env.local` (gitignored), are read only through `src/lib/env.ts` (`server-only`, Zod), and are never prefixed `NEXT_PUBLIC_`. Every variable is listed empty in `.env.example`. Never commit a secret; gitleaks runs pre-commit and in CI.
11. Private files are deployed/uploaded only through our own code and the client's accounts. Never send the repo or its files to third-party or anonymous upload/deploy endpoints.

## Caching and performance (ADR 0008)
- No cache inside MongoDB. Public catalog data uses the Next.js cache, tagged, and every admin mutation (product, category, area, datasheet, column visibility, bulk import) invalidates through ONE shared revalidation helper.
- Take the caching API from the installed Next.js docs (`node_modules/next/dist/docs/`), never from memory.
- Mongoose: cached global connection, `lean()` + field projection on reads, indexes declared in schemas (product `slug` unique, `mainCategory`, `extraCategories`, `areas`, `family`, `variants.modelNo`, `status`).

## Design
- Palette from the logo: black, white, warm greys; photography carries colour.
- Header: logo left · Product, Services, OEM/ODM, R&D, About us centred · search + account icons right (no language icon).
- References: HBA (nav, transitions, leadership carousel, closing page), Arelux (hero), Viabizzuno (7-area horizontal scroll), Delta Light (cookie banner, capabilities collage), KC Lighting (category icon strip in mega-menu).
- Respect `prefers-reduced-motion`. Horizontal-scroll sections become swipe carousels on mobile. Animations must not block first paint.
- Product, leader and factory photos are always real client photos — never AI-generated.

## Working conventions
- Start every session by reading `doc/tasks.md` (current phase + open tasks) and `doc/decisions/README.md` (ADR index). Decisions there override older text in this file until it is updated.
- End every session by ticking `doc/tasks.md`, adding a session-log line, and writing a new ADR in `doc/decisions/` for any design decision made.
- After EVERY task, before its commit, rewrite the "▶ Resume here" section at the top of `doc/tasks.md`:
  - the next task number and what it is;
  - which upcoming tasks get a QA review;
  - anything the user must do (e.g. env values);
  - must-do items carried into later tasks.
  The user may run `/clear` after any task, and a fresh session must be able to continue from that section alone.
- Build one phase at a time; plan first, then implement. Work on a `phase-N` branch; merge to `main` only when lint, typecheck, tests, build, audit and gitleaks are green and `qa-security-reviewer` passes.
- Subagents live in `.claude/agents/` (ADR 0013). The main session orchestrates and alone edits `doc/` and this file. Every changed source file is auto-reviewed by `code-reviewer` via hooks (ADR 0014); pause it with `.claude/reviews/.disabled` during scaffolding or bulk changes.
- Server Components by default; `"use client"` only where interaction/animation needs it.
- Keep admin UI plain and fast (shadcn); keep motion work in `components/motion/`.
