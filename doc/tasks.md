# Tasks

Working tracker for the YG UniLUX build. Update it at the end of every session: tick finished items, add new ones, and move "Current focus".
Decisions live in [decisions/](decisions/README.md). A task that settles a design question gets an ADR there.

## ▶ Resume here (next session)
- **Branch:** `phase-1`. **Tasks 1–12 and wrap-up steps 1, 2 and 2b are committed**, but only tasks 1–5 have been pushed. The Phase 1 exit criteria pass locally (QA PASS, 2026-10-04): the seeded admin signs in; `/admin` gives non-admins a real 403 on the server; a fake CN header gets 403. "On preview" waits for the client's Vercel account.
- **Next: Phase 1 wrap-up, before the merge to `main`.** Do these in order, one commit each:
  1. ~~Task-12 QA Lows~~ — done (ADR 0030): session tokens removed from every `/api/auth` JSON body, client aborts answered with a quiet 499, the e2e server blanks every `.env.example` variable, sign-out stays on the page if it fails, the login comment is fixed, and a signal crash exits 1.
  2. ~~Task-5 QA L1~~ — done (ADR 0031): `/change-password` allows 5 attempts per user per 15 minutes, counted in the before-hook before the password check (HMAC'd user id, generic 429, audit `user-pw-change`).
  2b. ~~"Keep me signed in"~~ — done (ADR 0032): the checkbox on `/login` is off by default for every role. Unchecked gives a browser-session cookie with a hard 24 h server cap; checked gives 7 days.
  3. **Next → Task-5 QA L2 (blocks the merge):** CI audit must be green. Replace the report-only full audit with a blocking `npm audit` script that allowlists only GHSA-vfj7-8cjw-p6xm (`eslint-config-next` chain; 5 highs today), plus a review date.
  4. Then run lint, typecheck, `npm test`, `npm run build`, `npm run test:e2e`, the audit and gitleaks.
  5. Push `phase-1`, check CI is green on GitHub, open a PR to `main`, merge, and tick Phase 1.
  6. Then **Phase 2 (Admin core)**: plan first (plan mode), on a `phase-2` branch.
- **QA after:** each Phase 2 feature plus the Phase 2 exit (`qa-security-reviewer`). Every changed file also gets the automatic per-file review.
- **Per task:** typecheck, lint and tests, then a tasks.md update and exactly one commit. Every file starts with a 2–3 line header comment and has "what and why" comments.
- **User must add to `.env.local`:**
  - `AUTH_URL=http://localhost:3000` (required);
  - `IP_HASH_SECRET` (32+ random characters, different from `AUTH_SECRET`);
  - a database name in `MONGODB_URI` (`…mongodb.net/yg_unilux?…`).
- **User should try once:**
  - `npm run seed:admin -- --email <admin email> --name "<name>"` from **PowerShell** (hidden prompt; Git Bash needs `winpty`). QA could not test a real Windows console.
  - From this machine Atlas currently times out (`querySrv ETIMEOUT`): check the Atlas IP access list / network.
- **Local dev:** use `http://localhost`, not `127.0.0.1`, because the `__Host-` device cookie needs it. `npm run test:e2e` needs port 3000 free (it never reuses a running server) and runs on a seeded in-memory MongoDB (ADR 0029).
- **Open QA Lows from task 5:**
  - L3 (Phase 5): sign-in and reset must post to `/api/auth/*`, never through server actions (`/login` already does). The change-password UI sends `revokeOtherSessions: true`.
- **Must-do items carried forward:**
  - Admin pages and layouts call `requireAdmin()` at the top, outside any `<Suspense>`/`loading.tsx`, so the 403 status is real. Admin Route Handlers use `requireAdminForRoute()`. Never wrap either in `try/catch` without `unstable_rethrow` (ADR 0024). `/admin` already guards in both the layout and the page (ADR 0029).
  - **Phase 2:** each admin Server Action gets a test that calls it as a customer and asserts nothing changed (QA L2, task 6).
  - **Phase 2:** admin uploads need `connect-src` hosts (Cloudinary upload API, R2 presigned PUT) added in `src/lib/security-headers.ts` with a note in ADR 0027. `dangerouslySetInnerHTML` is used only for JSON-LD (`JSON.stringify` with `<` escaped).
  - **Phase 2:** the admin UI uses shadcn under `src/app/admin` (outside `(site)`). Use design tokens and the contrast rules in ADR 0028.
  - **Phase 4:** move the footer's `new Date().getFullYear()` out of the prerender path before turning on `cacheComponents` (QA L1, task 11).
  - **Phase 5:** `/change-password` must exist before any path can create an admin with `mustChangePassword: true`. Today `seedAdmin` always sets it to false, and `requireAdmin()` would redirect such an admin to a 404. Customers currently land on `/` after sign-in.
  - **Phase 7:** remove the smoke test's "404 resource" console filter once every nav page exists (ADR 0029).
  - The blocked-page wording lives once, in `BLOCKED_COPY` (`src/lib/geo.ts`). `/blocked` stays outside `(site)` with no chrome (ADR 0026, 0028).
  - Tests never wait for Playwright `networkidle`: 404 prefetches never settle (ADR 0028).

**Current focus:** Phase 1 — Foundations — in progress (tasks 1–12 done; exit met locally; wrap-up + merge pending)

**Phase 1 decisions (user, 2026-10-01):**
- **Logo:** no SVG yet, so the header uses a text placeholder.
- **Fonts:** two Google Fonts, bundled at build time with `next/font`, so there are no runtime requests to Google. Pairing chosen 2026-10-04: Cormorant Garamond (headings) + Inter (body) — ADR 0028.
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
- [x] Task 5: Better Auth (`lib/auth.ts`, `auth-handler.ts`, `password-hash.ts`, `/api/auth/[...all]`); QA FAIL → fixed → re-review — ADR 0023
- [x] Task 3: `lib/rate-limit.ts` per-email limiter (HMAC keys, atomic window, fail closed); QA PASS — ADR 0020
  - [ ] Task 5 must: gate with `consume()`, clear on success and after password reset, generic 429, audit lockouts (ADR 0020 a/b/e/f)
  - [x] Task 7 must: `seed:admin` clears the admin's login/reset counters
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
- [x] Task 6: `lib/permissions.ts`: `requireAdmin` (redirect / `forbidden()` 403), `requireAdminForRoute` (JSON 401/403), `requireCustomerAccess`, `canSeeRestricted`; fail closed; `authInterrupts` on; QA PASS (L1 fixed, L2/L3 carried) — ADR 0024
- [x] Task 8: `src/proxy.ts` + `lib/geo.ts` + `lib/session-cookie.ts`: CN geo-block + coarse `/admin` redirect; QA PASS, L1 (matcher) fixed — ADR 0026
  - [x] The rewrite loses the 403 (Next source), so the proxy returns its own 403 page; verified with `next start` + curl
  - [x] A malformed `GEO_BLOCK_ENABLED` fails closed (block CN, log once) — ADR 0026
- [x] Task 9: security headers via `src/lib/security-headers.ts` + `next.config.ts`: static CSP (inline scripts allowed; tested that nonces/SRI don't fit), HSTS, nosniff, Referrer-Policy, framing, Permissions-Policy, whistleblower no-referrer, own headers on the CN 403 — ADR 0027
- [x] Task 10: `app/blocked/page.tsx` (static, noindex, shares `BLOCKED_COPY` with the proxy's 403 page)
- [x] Task 7: `scripts/seed-admin.ts` + `src/lib/seed-admin.ts` (`npm run seed:admin`: create, or `--reset` that ends sessions, unbans, bumps device epoch, clears counters); QA PASS, L-1..L-3 fixed — ADR 0025
- [x] Task 11: design tokens, fonts (Cormorant Garamond + Inter), header/footer shell, `(site)` group, 404/403/error/global-error; QA FAIL (footer focus + contrast) → fixed, QA e2e + axe green — ADR 0028
- [x] Task 12: `/login` (posts to `/api/auth`, method=post), `/admin` placeholder guarded in layout + page, sign-out; e2e on a seeded in-memory replica set (admin login, customer real 403, visitor/forged cookie → /login, CN 403, HK/MO/TW 200); QA PASS — ADR 0029
- [x] Tests: permissions matrix, rate limiter, proxy country matrix, env validation (773 unit + 34 e2e)
- **Exit:** seeded admin logs in; `/admin` rejects non-admin on server; fake `CN` header → 403 on preview — **met locally on `next start` (2026-10-04); preview pending the Vercel account**
- [ ] Phase 1 wrap-up: ~~task-12 Lows~~ (done, ADR 0030), ~~task-5 L1~~ (done, ADR 0031), ~~"Keep me signed in"~~ (done, ADR 0032), task-5 L2 (blocking audit), push, CI green, PR, merge to `main`

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
- [ ] Go-live: `GEO_BLOCK_ENABLED=true` in Production AND the Vercel Firewall CN rule active, both tested with a CN request (ADR 0026, QA L2 task 8)
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
- 2026-10-05 — Wrap-up step 2b committed, ADR 0032: a "Keep me signed in" checkbox, off by default, the same for admin and customers. 786 unit and 36 e2e tests green. Next: task-5 L2 (blocking audit script).
- 2026-10-05 — Wrap-up step 2 (task-5 QA L1) committed, ADR 0031: a per-user `/change-password` limit (5 per 15 min) runs before the password check; 786 unit tests green. The user accepted ADR 0030 and chose a "Keep me signed in" checkbox (default off, same for every role); that is step 2b, next.
- 2026-10-04 — Wrap-up step 1 (task-12 QA Lows) committed, ADR 0030. The auto-review widened two items: `token` is now stripped from every auth JSON body, not just sign-in (get-session and list-sessions leaked it too), and the abort check no longer swallows outgoing ECONNRESET or AbortError. It also caught the missing R2 variables in the e2e env, so the blanks are now read from `.env.example`. 779 unit and 34 e2e tests green. Next: task-5 L1.
- 2026-10-04 — Task 12 committed (/login, guarded /admin, e2e test server on in-memory MongoDB, ADR 0029). QA PASS and Phase 1 exit met locally; fixed the pre-hydration GET password leak (method=post); the stray `[auth] request failed` was a client abort (ECONNRESET). Next session: the Phase 1 wrap-up list in Resume, then merge and Phase 2.
- 2026-10-04 — Task 11 committed (design shell, ADR 0028). User picked Cormorant Garamond + Inter. QA FAIL on footer focus visibility (H1) and grey-500-on-ink contrast (H2); fixed, plus a mobile menu that closes on navigation/Escape/outside click (M1), wordmark size, footer prefetch. All 14 e2e (axe) tests and 771 unit tests green. Next: task 12.
- 2026-10-04 — Task 10 committed (/blocked page sharing BLOCKED_COPY with the proxy 403; verified live). Next: task 11 (design shell, QA).
- 2026-10-03 — Task 9 committed (security headers, ADR 0027). A browser test showed experimental SRI leaves App Router inline scripts blocked (hydration fails), so the CSP allows inline scripts; zero violations in prod, dev and on the 403 page. Next: task 10 (/blocked page).
- 2026-10-03 — Task 8 committed (proxy geo-block + coarse admin redirect, ADR 0026). The proxy returns its own 403 (a rewrite loses the status); verified live. QA PASS; L1 matcher anchoring fixed; L2/I1/I2 recorded (go-live checklist, hosting dependency). Next: task 9 (security headers).
- 2026-10-03 — Task 7 committed (seed:admin CLI, ADR 0025). QA PASS; fixed L-1 (no echo of stray args), L-2 (escape keys refused at prompt), L-3 (audit before counter clear). Atlas unreachable from this machine (SRV timeout). Next: task 8 (proxy).
- 2026-10-03 — Task 6 committed (permissions, ADR 0024). QA PASS with 13 real-session tests; L1 fixed (a missing `mustChangePassword` now fails closed). Next: task 7 (seed:admin).
- 2026-10-03 — Task 5 committed (Better Auth). QA found the /verify-password oracle, env overrides and the change-password epoch issue, all fixed. CI audit split (ADR 0015). Session ended here; resume at task 6.
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
