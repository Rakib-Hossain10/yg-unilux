# Tasks

Working tracker for the YG UniLUX build. Update it at the end of every session: tick finished items, add new ones, and move "Current focus".
Decisions live in [decisions/](decisions/README.md). A task that settles a design question gets an ADR there.

**Current focus:** Phase 1 — Foundations — in progress on branch `phase-1`

**Phase 1 decisions (user, 2026-10-01):**
- **Logo:** no SVG yet, so the header uses a text placeholder.
- **Fonts:** two Google Fonts, bundled at build time with `next/font`, so there are no runtime requests to Google.
- **Malformed `GEO_BLOCK_ENABLED`:** fail closed. Block CN and log the error; ADR in task 8.
- **Email:** no verified Resend domain yet. Reset emails are tested only to the user's own Resend account email.
- **QA:** `qa-security-reviewer` runs after tasks 3, 5, 6, 7, 8, 11 and 12. The other tasks get only the automatic per-file review.
- **Comments:** every file starts with a 2–3 line plain-English header. Important functions and blocks get a short "what and why" comment; obvious lines don't.
- **Per task:** typecheck, lint and tests, then a tasks.md update and exactly one commit.
**Working method:** plan mode → approve → small commits on a `phase-N` branch → lint + typecheck + tests + build green → security check against CLAUDE.md → PR → merge → tick here.

---

## Phase 0 — Setup & tooling (no features)
- [x] Read client requirement PDF, plan PDF and CLAUDE.md
- [x] Install `find-skills` skill
- [x] Approve full roadmap
- [x] Create `doc/tasks.md` and `doc/decisions/` (ADRs 0001–0012)
- [x] Install all project skills (20) and create 6 subagents in `.claude/agents/` — ADR 0013
- [x] Automatic per-file review: `.claude/agents/code-reviewer.md` + PostToolUse/FileChanged hooks — ADR 0014
- [x] Commit setup work on `main`
- [x] Reload session, verify agents + skills + hooks load (`/agents`, `/hooks`)
- [x] Decide security tooling: Dependabot (weekly, grouped; Next/React majors manual), `npm audit --audit-level=high` in CI, gitleaks in CI + pre-commit; CodeQL only if free on private repo, else skip + ADR 0015. Phase 0 plan approved in chat.
- [x] Install gitleaks 8.30.1 locally (winget; on user PATH after shell restart)
- [x] Gitleaks baseline: first history scan flags 1 false positive (`mockToken` example in `.claude/skills/playwright-best-practices/advanced/authentication-flows.md:54`). Add its fingerprint to `.gitleaksignore` (narrow, not a path allowlist) in Phase 0
- [ ] User checks GitHub → Settings → Code security (Dependabot alerts, code scanning, secret scanning) and reports what is available
- [x] Before scaffolding/`npm install`: `touch .claude/reviews/.disabled`
- [x] Remove `.claude/reviews/.disabled` after merge (done 2026-10-01; hook verified working)
- [x] Scaffold Next.js 16.3.7 (TS, App Router, `src/`, Tailwind 4, ESLint, `@/*`) with placeholder page
- [x] Read installed Next docs for caching, `proxy.ts` and dynamic APIs; finalised ADR 0008 + 0007
- [x] Install dependencies (ADR 0011): all except the auth library
- [x] **Decide the auth library**: Better Auth 1.7.7 + `mongodb@~7.6` (one shared driver) — ADR 0017
- [x] Config: strict tsconfig, Prettier, ESLint (bans `NEXT_PUBLIC_*`), Vitest, Playwright, npm scripts
- [x] `src/lib/env.ts` (Zod, server-only, lazy per feature, 43 tests) + `.env.example`; `.env*.local` gitignored
- [x] Update CLAUDE.md: 11 collections, `datasheetId`, `proxy.ts`, caching + no-restricted-data-in-cache, rate limit, keys, secrets, R2, npm/Vitest/Playwright
- [x] `.gitattributes` (LF), Dependabot, CI (checks + audit, e2e, gitleaks), gitleaks config + husky pre-commit — ADR 0015
- [x] `qa-security-reviewer` on `phase-0`: FAIL → fixed (F1 gitleaks allowlist, F2 NEXT_PUBLIC bypasses, F3 whitespace, F5 npm pin, F7 uuid) → re-review FAIL on N1 (devEngines `error` breaks npm 10) + N2 (config glob too broad) → both fixed by orchestrator and verified
- [x] Push `phase-0`, CI green on GitHub, merged to `main` (PR #1)
- [ ] Link Vercel project, deploy blank app — **deferred: client's Vercel account doesn't exist yet**
- **Exit:** CI green, docs committed (Vercel preview once the account exists)

## Between phases
- [x] `CLOUDINARY_URL` replaces the three Cloudinary variables; next/image limited to our cloud — ADR 0016 (branch `chore/cloudinary-url`)
- [x] Direct `mongodb` dependency: needed by Better Auth's adapter; pinned to Mongoose's range `~7.6` so npm dedupes to one copy (test + Dependabot ignore) — ADR 0017

## Phase 1 — Foundations
- [x] Task 1: `lib/db.ts`, one shared `MongoClient` for Mongoose and Better Auth, strict Mongoose, `MONGODB_URI` must name the database — ADR 0018
- [x] Task 2: 11 Mongoose models + read-only `users` + `loginAttempts` (TTL), `spec-columns.ts`, `npm run db:indexes` — ADR 0019 (8 open questions listed there)
- [ ] Task 5 must also apply ADR 0022's 'Required in task 5' list (issue a device token on password reset, token epoch, path passed to clearSignIn, wider guard, Better Auth limiter storage, reset hardening)
- [ ] `lib/auth.ts` with Better Auth per ADR 0017: Mongo adapter on Mongoose's client, `disableSignUp`, admin plugin (admin/customer), additionalFields (mustChangePassword, accessExpiresAt, company, country), argon2id, Resend reset, DB rate limit + per-email hook, telemetry off; route `app/api/auth/[...all]`; fix the `env.auth()` comment
- [x] Task 3: `lib/rate-limit.ts` per-email limiter (HMAC keys, atomic window, fail closed); QA PASS — ADR 0020
  - [ ] Task 5 must: gate with `consume()`, clear on success and after password reset, generic 429, audit lockouts (ADR 0020 a/b/e/f)
  - [ ] Task 7 must: `seed:admin` clears the admin's login/reset counters
  - [ ] User decision: add per-(email + hashed IP) key against targeted lockout (ADR 0020 c)
- [x] Task 4: `lib/email.ts` Resend sender + password-reset template; `env.isProduction()` — ADR 0021
- Task 3b QA (2026-10-02) FAIL → user decisions:
  - H1: a signed **known-device cookie** (OWASP device cookies), so known devices skip the shared per-email slow-down and have their own 5/15 min limit. Polling during a wait is no longer free (no give-back).
  - On success, clear only the caller's network counter (not the slow-down).
  - Reset requests get the same per-network + never-zero per-email treatment in task 5.
  - Fixes in progress: M2 wider whistleblower ESLint guard, L1 cap refusals, L2 private give-back, L3 IP_HASH_SECRET ≠ AUTH_SECRET.
  - Task 5 note (QA M1): Better Auth's built-in limiter stores raw `ip|path` keys, so it must use HMAC'd custom storage or be turned off for these paths. Set `ipAddressHeaders: ["x-vercel-forwarded-for"]` and `ipv6Subnet: 64`.
- [x] Task 3b: per-network limit (HMAC'd IP, `x-vercel-forwarded-for`), per-email slow-down, known-device cookie, wider whistleblower guard; QA PASS on the second review — ADR 0022
- [ ] Privacy + cookie pages (Phase 7) must include `doc/content/privacy.md` (login-attempt line + `__Host-yg-device` cookie)
- [ ] `lib/permissions.ts`: `requireAdmin`, `requireCustomerAccess`, `canSeeRestricted`
- [ ] `src/proxy.ts`: CN geo-block + coarse `/admin` guard — ADR 0003, 0007
  - [ ] e2e: prove whether `NextResponse.rewrite(url, { status: 403 })` keeps the 403; else return a 403 response directly
  - [ ] Policy for a malformed `GEO_BLOCK_ENABLED` (`env.geoBlockEnabled()` throws): catch `EnvError`, choose fail-closed vs off, and record it in an ADR (QA finding F4)
- [ ] Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors) in `next.config.ts`
- [ ] `app/blocked/page.tsx`
- [ ] `scripts/seed-admin.ts` (create / reset from CLI)
- [ ] Design tokens, fonts, header shell, footer shell, 404/500
- [ ] Minimal `/login` page + placeholder `/admin` page behind `requireAdmin()`; e2e: admin logs in, customer gets 403, visitor redirected
- [ ] Tests: permissions matrix, rate limiter, proxy country matrix, env validation
- **Exit:** seeded admin logs in; `/admin` rejects non-admin on server; fake `CN` header → 403 on preview

## Phase 2 — Admin core
- [ ] shadcn init; admin layout with `requireAdmin()` everywhere
- [ ] Dashboard counts
- [ ] Categories tree editor
- [ ] Areas module
- [ ] Products CRUD + Cloudinary upload/reorder
- [ ] Datasheets module (R2, signature check, ≤10 MB, attach to many, block delete in use) — ADR 0001, 0009
- [ ] Settings: column visibility, WhatsApp number, company email
- [ ] auditLog on every write; tag revalidation on every save — ADR 0008
- [ ] Tests: Zod schemas, file signature, auth guard on every admin action
- **Exit:** full product built by hand with images and attached datasheet

## Phase 3 — Bulk import
- [ ] Get client's Arc sheet as fixture
- [ ] Cell cleaner, multi-line options, numeric parsers
- [ ] Row grouping by `NO.`, shared-vs-variant diffing, slug builder
- [ ] Image extraction from `xl/drawings` → Cloudinary
- [ ] Preview with per-row warnings → confirm → upsert by model no. → revalidate
- [ ] Vitest against fixture (No. 76 → AR-013A1/A2)
- **Exit:** re-import changes nothing, no duplicates

## Phase 4 — Public catalog
- [ ] `lib/catalog/` cached + tagged, restricted fields excluded by projection — ADR 0002
- [ ] Mega-menu (icon strip + subcategories)
- [ ] Listing pages + URL filters, sort, pagination; area pages
- [ ] Product page: gallery/zoom, variant switch, public specs, family strip, related
- [ ] Dynamic `<Suspense>` block: restricted specs + datasheet button states
- [ ] Search overlay: Atlas Search + regex fallback — ADR 0006
- [ ] Playwright: restricted-leak check, filters, search by variant model no.
- **Exit:** leak test passes; Lighthouse ≥ 90 on listing + product page

## Phase 5 — Restricted access
- [ ] Request Access form + WhatsApp link
- [ ] Admin queue: approve with expiry / reject; Resend emails
- [ ] Customers module (create, extend, reset, disable, history, filters)
- [ ] Customer login, forced password change, email reset (admin too), `/my-downloads`
- [ ] `/api/datasheet/[productId]` → R2 presigned 60 s + downloadLogs, `private, no-store`
- [ ] Cron expiry reminders (`CRON_SECRET`, `vercel.json`)
- [ ] Tests: access matrix + Playwright gated download

## Phase 6 — Home page & motion
- [ ] Hero · Quote · 7-area horizontal scroll · Capabilities collage · Leadership · Closing menu
- [ ] Lenis + ScrollTrigger, page transitions, reduced-motion fallback, mobile swipe

## Phase 7 — Content pages
- [ ] Services, OEM/ODM, R&D, About (6 sub-sections), Contact
- [ ] Terms, Privacy, Cookies, Legal; cookie banner
- [ ] Admin Site Content + Leaders editors

## Phase 8 — Whistleblower
- [ ] Landing page + named mailto
- [ ] Anonymous form → case no. + password once; secure inbox
- [ ] `lib/crypto.ts` AES-256-GCM + keyVersion — ADR 0005
- [ ] Attachments: sharp EXIF strip → R2; no IP, no analytics
- [ ] Content-free alert email; admin case inbox
- [ ] Tests: crypto round trip, no IP stored, EXIF removed

## Phase 9 — Polish
- [ ] Metadata, sitemap, JSON-LD (public fields only)
- [ ] Image/video tuning, a11y pass, mobile pass
- [ ] `/security-review` + `/code-review` against CLAUDE.md rules

## Phase 10 — Launch
- [ ] Deploy via client-linked Vercel project (no third-party deploy scripts)
- [ ] Fluid compute: check current Vercel docs for `attachDatabasePool(client)` (`@vercel/functions`); decide `waitQueueTimeoutMS` after a load test (ADR 0018)
- [ ] Real content, Vercel Firewall CN rule, domain
- [ ] Test every role + China block on production
- [ ] Admin handover guide + encryption-key backup instructions

---

## Needed from user / client
- [ ] Client's Arc spec sheet (.xlsx) — before Phase 3
- [ ] MongoDB Atlas, Cloudinary, Cloudflare R2, Resend, Vercel accounts — before Phases 1–5
- [ ] Company email (whistleblower + request alerts)
- [ ] Logo files (SVG preferred) — Phase 1
- [ ] Categories 8–10; empty subcategories (Hanging 3rd, Track Light, Motorized)
- [ ] Open client questions: admin from China, Catalog/Knowledge footer links, WeChat icon, sheet questions (Nos. 80/81, lm/W tolerance, empty columns, public/restricted split)

## Session log
- 2026-10-02 — Task 3b committed after two QA rounds (FAIL → user chose a known-device cookie → PASS); ADR 0022; privacy/cookie text drafted; ADR 0004/0020 updated.
- 2026-10-02 — Task 4 committed (Resend email sender, ADR 0021). User approved per-network limit + progressive slow-down (task 3b).
- 2026-10-02 — Task 3 committed (per-email rate limiter); QA PASS; applied QA L1 (HKDF subkey), L2 (length cap), M1 (doc: gate with consume only); ADR 0020.
- 2026-10-02 — Task 2 committed (models + index script); whistleblower schema hardened after review (neutral file names, size caps, MIME allow-list); ADR 0019.
- 2026-10-01 — Task 1 committed (db.ts, ADR 0018).
- 2026-10-01 — Auth decided: Better Auth (ADR 0017) after checking current Better Auth and Auth.js docs; installed better-auth 1.7.7 + mongodb ~7.6 (deduped with Mongoose); CLAUDE.md, ADR 0004/0011 updated. User rotated the Cloudinary secret.
- 2026-10-01 — Phase 0 merged (PR #1). Review hook re-enabled. Switched to a single `CLOUDINARY_URL` (ADR 0016) and fixed the user's next.config edit (missing comma, unrestricted Cloudinary host).
- 2026-09-30 — Read all docs, settled ADRs 0001–0012, approved roadmap, created `doc/`.
- 2026-09-30 — Installed 20 skills, rejected `code-review` (mattpocock) and `deploy-to-vercel`; created 6 subagents (ADR 0013).
- 2026-10-01 — Two QA rounds on Phase 0; all findings fixed; F4/F6 documented (ADR 0015, Phase 1 tasks); npm 12 via devEngines `warn` (ADR 0011).
- 2026-09-30 — Phase 0 built by backend-architect on `phase-0` (9 commits); ADRs 0007/0008/0010/0011 updated from installed Next 16.3.7 docs; ADR 0015 added; Auth.js found to be maintenance-only → decision pending.
- 2026-09-30 — Added the automatic review hook (ADR 0014) and moved code-reviewer into `.claude/agents/`; replaced the find-skills symlink with a copy (`core.symlinks=false`); committed the setup on `main`. Vercel deferred.
