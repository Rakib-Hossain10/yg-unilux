# Tasks

Working tracker for the YG UniLUX build. Update it at the end of every session: tick finished items, add new ones, and move "Current focus".
Decisions live in [decisions/](decisions/README.md). A task that settles a design question gets an ADR there.

**Current focus:** Phase 1 — Foundations (blocked on: auth library decision, `MONGODB_URI`)
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
- [ ] **Decide the auth library** (Auth.js is security-fixes-only upstream; Better Auth recommended upstream) — blocks Phase 1 auth; new ADR
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
- [ ] Decide: keep or drop the direct `mongodb` dependency the user added (Mongoose already bundles the driver)

## Phase 1 — Foundations
- [ ] `lib/db.ts` cached global Mongoose connection
- [ ] 11 Mongoose models + `loginAttempts` (TTL); indexes per ADR 0008
- [ ] `lib/auth.ts` Auth.js credentials, role/status/expiry/mustChangePassword in session
- [ ] `lib/rate-limit.ts` (per email + per IP, TTL) — ADR 0004
- [ ] `lib/permissions.ts`: `requireAdmin`, `requireCustomerAccess`, `canSeeRestricted`
- [ ] `src/proxy.ts`: CN geo-block + coarse `/admin` guard — ADR 0003, 0007
  - [ ] e2e: prove whether `NextResponse.rewrite(url, { status: 403 })` keeps the 403; else return a 403 response directly
  - [ ] Policy for a malformed `GEO_BLOCK_ENABLED` (`env.geoBlockEnabled()` throws): catch `EnvError`, choose fail-closed vs off, and record it in an ADR (QA finding F4)
- [ ] Security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, frame-ancestors) in `next.config.ts`
- [ ] `app/blocked/page.tsx`
- [ ] `scripts/seed-admin.ts` (create / reset from CLI)
- [ ] Design tokens, fonts, header shell, footer shell, 404/500
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
- 2026-10-01 — Phase 0 merged (PR #1). Review hook re-enabled. Switched to a single `CLOUDINARY_URL` (ADR 0016) and fixed the user's next.config edit (missing comma, unrestricted Cloudinary host).
- 2026-09-30 — Read all docs, settled ADRs 0001–0012, approved roadmap, created `doc/`.
- 2026-09-30 — Installed 20 skills, rejected `code-review` (mattpocock) and `deploy-to-vercel`; created 6 subagents (ADR 0013).
- 2026-10-01 — Two QA rounds on Phase 0; all findings fixed; F4/F6 documented (ADR 0015, Phase 1 tasks); npm 12 via devEngines `warn` (ADR 0011).
- 2026-09-30 — Phase 0 built by backend-architect on `phase-0` (9 commits); ADRs 0007/0008/0010/0011 updated from installed Next 16.3.7 docs; ADR 0015 added; Auth.js found to be maintenance-only → decision pending.
- 2026-09-30 — Added the automatic review hook (ADR 0014) and moved code-reviewer into `.claude/agents/`; replaced the find-skills symlink with a copy (`core.symlinks=false`); committed the setup on `main`. Vercel deferred.
