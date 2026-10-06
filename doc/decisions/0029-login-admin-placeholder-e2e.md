# 0029 — Login page, guarded /admin placeholder, e2e on an in-memory database
- Status: Accepted
- Date: 2026-10-04
- Implements: Phase 1 task 12 and the Phase 1 exit checks

## Context
The Phase 1 exit requires three things: the seeded admin signs in; `/admin` rejects non-admins on the server; a `CN` request gets 403. These must be proven end to end in a browser. Two constraints:
- QA L3 (task 5) requires sign-in to post to `/api/auth/*`, never through a Server Action.
- The real Atlas cluster isn't reachable from every machine and must never be touched by tests.

## Decision
- **`/login`**, in the `(account)` group with `SiteShell`, is static and `noindex`.
  - `LoginForm` is a client component: React Hook Form + Zod for quick feedback, then a same-origin JSON `POST /api/auth/sign-in/email`. Our hook validates with Zod again and runs the rate limits; Better Auth checks Origin/CSRF.
  - Messages are fixed per status, and none reveals whether an email exists: 400/401 → "Email or password is incorrect.", 403 → disabled, 429 → wait, other → unavailable.
  - The form has `method="post"`. A submit before hydration (or without JS) must never fall back to GET, which would put the password in the URL; QA reproduced exactly that before the fix.
  - After sign-in the destination comes from the returned `user.role`: admin → `/admin`, everyone else → `/`. No `next=` parameter is read, so there is no open redirect.
- **`/admin`** (placeholder until Phase 2):
  - `requireAdmin()` runs in `admin/layout.tsx` (full loads) **and** in `admin/page.tsx`, because layouts don't re-render on client navigation;
  - it is called at the top, outside any Suspense, so a customer gets a real HTTP 403 (verified in e2e);
  - sign-out POSTs `/api/auth/sign-out`.
- **E2E server** (`e2e/test-server.ts`), started by `playwright.config.ts` after `npm run build`:
  1. a fresh `MongoMemoryReplSet` (Better Auth uses transactions);
  2. indexes through our sync code;
  3. the admin seeded through `seedAdmin` and a customer through `createUser`;
  4. then `next start` with random per-run `AUTH_SECRET`/`IP_HASH_SECRET`, `AUTH_URL=http://localhost:3000` and `GEO_BLOCK_ENABLED=true`.
  - `reuseExistingServer: false`, so a developer's `next dev` on the real database is never used by tests.
  - Test accounts live in `e2e/fixtures/accounts.ts`.
  - An ESLint exception allows `process.env` in `e2e/test-server.ts` only; the import guards stay on.
- **E2E coverage** (`e2e/auth-access.spec.ts`):
  - visitor → `/login`;
  - admin sign-in → `/admin` → sign-out;
  - customer → real 403;
  - wrong password → generic message;
  - forged session cookie → passes the proxy, stopped by `requireAdmin()`;
  - `/admin` without a cookie → 307 to `/login`;
  - CN → 403, and HK/MO/TW → 200.
  - The smoke test ignores only Chromium's "Failed to load resource … 404" lines, which come from prefetches of nav pages not built yet.

## QA (2026-10-04): PASS, Phase 1 exit met locally
- The one-off `[auth] request failed: Error` log is Node's `Error: aborted` (ECONNRESET): a client closed the socket before the body was read, after a stalled request timed out in the test. It is not a database race. Concurrent sign-ins on a cold replica set are clean (QA test `src/lib/sign-in-concurrency.qa.test.ts`).
- Lows carried in `doc/tasks.md`:
  - treat client aborts as non-errors in `auth-handler.ts`;
  - blank the inherited `.env.local` secrets in `e2e/test-server.ts`;
  - `rememberMe` is hard-coded to true;
  - the `token` is in the sign-in JSON;
  - sign-out leaves the page even when the request failed;
  - an admin with `mustChangePassword` must never exist before `/change-password` does.

## Consequences
- The e2e suite needs the MongoDB binary (downloaded on first use, as for Vitest) and port 3000 free.
- Customers land on `/` after sign-in until Phase 5 adds `/my-downloads` and the forced password change.
- Remove the smoke test's 404 filter once every nav page exists (Phase 7).
