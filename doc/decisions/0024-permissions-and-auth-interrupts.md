# 0024 — Permission checks and `forbidden()` (authInterrupts)
- Status: Accepted
- Date: 2026-10-03
- Implements: CLAUDE.md security rules 2, 3 and 9 (Phase 1 task 6)

## Context
Admin pages, admin API routes, Server Actions, the datasheet route and the restricted-specs block all need the same access rules, checked on the server against the session in the database. A signed-in non-admin hitting `/admin` should get a real 403 (Phase 1 exit test), not a redirect. In Next.js 16.3.7, `forbidden()` from `next/navigation` gives that 403, but it is experimental and needs `experimental.authInterrupts: true`.

## Decision
- **One module, `src/lib/permissions.ts`.**
  - Pure rules, tested directly: `isBanned`, `isActiveAdmin`, `checkDatasheetAccess`, `canSeeRestricted`.
  - Thin request wrappers: `getViewer` (React `cache`, one database read per request), `requireAdmin`, `requireAdminForRoute`, `requireCustomerAccess`, `viewerCanSeeRestricted`.
- **Datasheet and restricted-data rule**, checked in this order:
  1. signed in;
  2. role is admin or customer;
  3. not banned;
  4. `mustChangePassword` is explicitly `false`;
  5. `accessExpiresAt` is null or in the future.

  The admin skips only step 5. Restricted specs follow exactly the same rule.
- **Temporary passwords unlock nothing.** A user with `mustChangePassword` gets no datasheets and no restricted specs, admin included, so an intercepted welcome password can't be used for downloads.
- **Fail closed.**
  - An unreadable `accessExpiresAt` counts as expired. An unreadable `banExpires` counts as banned.
  - Only an explicit `mustChangePassword: false` counts as "password changed". A missing or non-boolean value means it must still be changed (QA L1).
  - A ban whose `banExpires` has passed no longer counts, which matches Better Auth.
  - Database errors are thrown, never treated as "signed out".
- **`requireAdmin()`** is for pages and Server Actions:
  - signed out → `redirect("/login")`;
  - signed in but not an active admin → `forbidden()` (403);
  - an admin who still has to change their password → `redirect("/change-password")`.
- **`requireAdminForRoute()`** is for admin Route Handlers. It answers JSON 401/403 with `Cache-Control: private, no-store`, because a redirect to an HTML login page would look like success to `fetch()`.
- **`experimental.authInterrupts: true`** is set in `next.config.ts`.

## Consequences
- `forbidden()` and `redirect()` work by throwing. Never wrap `requireAdmin()` in `try/catch` without `unstable_rethrow`, or the interrupt is swallowed.
- **Real 403 status.** The 403 status is real only when the check runs before streaming starts. A check inside a `<Suspense>` boundary is sent as 200, with the forbidden UI (installed docs: `forbidden.md`, "trade-off is the HTTP status code"). Admin layouts and pages call `requireAdmin()` at the top, outside any Suspense boundary. If `cacheComponents` is turned on later, the 403 status must come from `proxy.ts`. The server-side check still stays in every page, action and route.
- `authInterrupts` is experimental: re-check it on every Next.js upgrade.
- A custom `app/forbidden.tsx` page is added with the 404/500 pages (Phase 1 design-shell task).
- **Must-do for `seed:admin` (task 7):** it must set `mustChangePassword: false` for the admin, whose password was chosen on the CLI. Otherwise the admin is redirected to `/change-password`, a page that doesn't exist until Phase 5.
