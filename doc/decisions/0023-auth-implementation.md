# 0023 — Better Auth implementation details
- Status: Accepted
- Date: 2026-10-03
- Implements: ADR 0017 and ADR 0022's "Required in task 5" list

## Decision
- **Construction:** `src/lib/auth.ts` builds Better Auth 1.7.7 (`better-auth/minimal`) lazily through `getAuth()`, cached on `globalThis`, because constructing it starts async initialisation. `withAuth` and the route handler await `connectDb()` first.
- **Route:** `src/app/api/auth/[...all]/route.ts` uses the Node runtime and `await connection()` (no `export const dynamic`, which breaks once `cacheComponents` is on).
  - The handler adds `Cache-Control: private, no-store`.
  - It gives generic 500/503 responses (`onAPIError.throw`) and adds `Retry-After` on 429.
- **`AUTH_URL` is required and must be a bare origin,** so reset links can't be poisoned through the Host header. Each Vercel environment, every Preview included, needs its own value. CSRF and origin checks are explicitly on.
- **Email and password:**
  - Sign-up is disabled; the minimum password length is 12.
  - Reset tokens are stored hashed (`storeIdentifier: "hashed"`).
  - `revokeSessionsOnPasswordReset` is on.
  - Passwords are hashed with argon2id (m=19456, t=2, p=1, the OWASP minimum) in `src/lib/password-hash.ts`.
  - `createUser` doesn't enforce the minimum length, so every place that creates an account (admin UI, access-request approval, `seed:admin`) must Zod-check 12 characters.
- **Admin plugin:** roles `admin` and `customer`. Admin gets Better Auth's admin statements **minus impersonation**; customer gets none. `hasRole()` splits the comma-joined role string.
- **User fields:**
  - `additionalFields` (all `input: false`): `mustChangePassword`, `accessExpiresAt`, `company`, `country`, `deviceEpoch`. `deviceEpoch` is also `returned: false`.
  - `src/models/user.ts` mirrors them.
- **Sessions:**
  - Stored in the database, with no cookie cache. `getSessionFromDb` also passes `disableCookieCache`.
  - **No IP on sessions:** `databaseHooks.session.create.before` sets `ipAddress: ""`. The user agent is still stored.
  - Production cookies are `__Secure-yg.session_token` and `__Secure-yg.dont_remember`.
- **Limits** (ADR 0022):
  - The sign-in gate in `hooks.before` calls `consumeSignIn()`. On success the after hook calls `clearSignIn(path)` (QA L2) and issues the device cookie.
  - **Reset requests:**
    - per (email + network): 3 per 15 min, hard (every IP-derived record has a TTL of 15 min or less);
    - per email: 3 free, then 1 per 10 min, never zero, resetting after 1 h (no IP).
  - **Better Auth's own limiter** uses `customStorage`, which HMACs its `ip|path` key under the `IP_HASH_SECRET` subkey into `loginAttempts` (`ba-limit:`) with a window of 900 s or less. No `rateLimits` collection exists.
    - Rules: sign-in 20/60 s per network; reset request and `/reset-password` 10 per 15 min; default 100/60 s; `/get-session` excluded.
  - IP header: `x-vercel-forwarded-for`, `ipv6Subnet: 64`.
- **Device tokens:** v2 format, with the MAC over `v2|emailHash|deviceEpoch|nonce|issuedAt`.
  - The epoch is bumped by a successful reset (by body or `?token=`), an admin `setUserPassword` (which also revokes sessions first, and fails loudly if either step fails), a ban, and `update-user` with `banned: true`.
  - **QA M1 recovery:** a completed reset also clears every counter for the email and issues a fresh device cookie.
- **Account existence never leaks:**
  - Identical statuses and bodies for known and unknown emails.
  - The reset email is sent in the background (`advanced.backgroundTasks` → Next `after()`), and send errors are swallowed with a safe log.
  - Better Auth's logger is set to `error`, because its WARN lines distinguish "user not found" from "invalid password".
- **Telemetry** is off, and `env.auth()` refuses to start if `BETTER_AUTH_TELEMETRY` is truthy (it would override the config).
- **Indexes:** `npm run db:indexes` builds Better Auth's indexes with the raw driver: unique email, unique session token, sessions/accounts by `userId`, verifications by `identifier`, and TTL indexes on `sessions.expiresAt` and `verifications.expiresAt`.
  - Without them nothing enforces a unique email: the adapter's `ensureModelIndexes` builds none for the core schema.
- **Audit:** `auth.rate_limited` entries hold only `{ namespace, reason }`, with `actor` optional for anonymous `auth.*` events.
- **Tests** run Better Auth on `MongoMemoryReplSet`, with transactions on, as in production.

## Added after QA (2026-10-03)
- **`DISABLED_PATHS` (`disabledPaths`):** 16 Better Auth routes return 404 over HTTP. They include `/verify-password` (it acted as a password oracle for anyone holding a session), `/sign-up/email`, the social/linking/token routes, `/change-email`, `/delete-user`, the email-verification routes, `/update-user` (no profile editing) and admin impersonation.
  - Server code calling `auth.api.*` isn't affected.
- **`/change-password`:**
  - rate-limited at 10 per 15 min per network;
  - on success, bumps `deviceEpoch` and issues a fresh device cookie to the browser that changed it;
  - the Phase 5 UI must send `revokeOtherSessions: true`.
- **`env.auth()` refuses to start** if `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS`, `BETTER_AUTH_URL`, `BETTER_AUTH_TRUSTED_ORIGINS` or `BETTER_AUTH_TELEMETRY` is set. Better Auth would read them directly and bypass `env.ts`.
- **Phase 5 (QA L4):** Better Auth's per-network limiter and its origin/CSRF checks run only for HTTP requests to `/api/auth/*`. Sign-in and reset must post there from the client, not call `auth.api.*` from a server action.

## Follow-ups
- **Phase 5:** the `mustChangePassword` redirect, plus a server action that clears the flag after a password change. Better Auth's `/change-password` doesn't touch `input: false` fields.
- **Task 7:** `seed:admin` Zod-checks the password length, calls `clearAllForEmail`, and optionally provides a one-time way to give the admin a device token.
- **Phase 10:** confirm one fixed `AUTH_URL` per Vercel environment (a branch alias), rather than Better Auth's dynamic `allowedHosts`.
