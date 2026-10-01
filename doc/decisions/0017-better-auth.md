# 0017 — Better Auth for authentication
- Status: Accepted
- Date: 2026-10-01
- Supersedes: the "Auth.js" choice in the original plan and CLAUDE.md; resolves the open item in ADR 0011

## Context
Phase 0 found that Auth.js is now part of Better Auth and gets only security patches and urgent fixes. v5 is still `5.0.0-beta.32`, and Auth.js's own README recommends Better Auth for new projects. Both libraries were checked against our requirements in their current docs (2026-10-01): better-auth.com docs (email/password, admin plugin, rate limit, MongoDB adapter, options, telemetry) and authjs.dev (credentials provider).

## Requirements vs. libraries

| Requirement | Better Auth 1.7.7 | Auth.js v5 beta |
|---|---|---|
| Credentials login only | ✅ `emailAndPassword`, no social providers configured | ✅ Credentials provider, but "does not persist data in the database"; we write everything |
| Public sign-up disabled | ✅ `emailAndPassword.disableSignUp: true`; admin `createUser` still works | ⚠️ n/a (no sign-up exists; we'd build the admin-side user creation ourselves) |
| Roles admin / customer | ✅ admin plugin: `defaultRole: "customer"`, `adminRoles: ["admin"]`, custom roles via `createAccessControl` | ⚠️ hand-built in `jwt`/`session` callbacks |
| `mustChangePassword` flag | ⚠️ not built in: `user.additionalFields` boolean (`input: false`) plus our redirect | ⚠️ not built in: same, hand-built |
| Login rate limiting | ⚠️ built in **per IP only** (sign-in default 3 requests / 10 s; `storage: "database"` for serverless). Per-email limit is ours (ADR 0004) via a `hooks.before` check | ❌ none; the docs say to add it yourself |
| Password reset via Resend | ✅ `sendResetPassword({ user, url, token })` callback; token valid 1 h (`resetPasswordTokenExpiresIn`); `revokeSessionsOnPasswordReset` | ❌ none for credentials; build the tokens, emails and flow ourselves |
| Block a customer | ✅ admin `banUser` (`banReason`, `banExpiresIn`): a banned user can't sign in, and all sessions are revoked. `unbanUser` reverses it | ❌ hand-built; with JWT-only credentials sessions, a ban only takes effect if we re-check the DB on every request |
| Expire download access | ⚠️ not an auth concept: our `accessExpiresAt` additional field (login still works, downloads lock) | ⚠️ same, hand-built |
| MongoDB, Mongoose-compatible | ✅ `mongodbAdapter(db, { client })` from `better-auth/adapters/mongodb`, needs the official `mongodb` driver. We pass Mongoose's own connection (`mongoose.connection.getClient()`), so there is one pool. No migrations for Mongo | ⚠️ `@auth/mongodb-adapter` exists, but credentials sessions are JWT-only, so it would not store sessions |
| Maintained | ✅ active (1.7.7 published 2026-09-30); peers include `next ^16`, `react ^19`, `mongodb ^6 \|\| ^7`; uses `zod ^4`, matching ours | ❌ security fixes only; v5 never left beta |

**Gaps in Better Auth:**
- No per-email login limit; we keep ADR 0004's MongoDB TTL counter for the email key.
- No `mustChangePassword` flag; it's an additional field plus a redirect.

Both are small and live in our code. Download-access expiry is domain logic under either library.

**Auth.js** is missing four items outright (rate limiting, password reset, blocking, real session revocation), and is in maintenance mode.

## Decision
Use **Better Auth** (`better-auth@^1.7.7`), installed together with **`mongodb@~7.6.0`**, which is Mongoose 9.10's own driver range. That way npm dedupes Mongoose, Better Auth and our code to **one** driver copy.
- A test (`test/deps/mongodb-driver.test.ts`) fails if a second copy appears.
- Dependabot ignores `mongodb` minor and major bumps, so it is updated by hand together with `mongoose`.
- Dependabot also ignores `better-auth` majors.

Configuration for Phase 1 (`src/lib/auth.ts`):
- **Database:** `mongodbAdapter(db, { client })` using the cached Mongoose connection's client (`src/lib/db.ts`). Collection names are set to plural (`modelName`) to match ours: `users`, `sessions`, `accounts`, `verifications`, `rateLimits`.
- **`emailAndPassword`:**
  - `enabled: true`, `disableSignUp: true`, `requireEmailVerification: false` (the admin creates accounts with known emails)
  - `minPasswordLength: 12`
  - `revokeSessionsOnPasswordReset: true`
  - `sendResetPassword` sends the email through Resend (`src/lib/email.ts`)
  - `password.hash` / `password.verify` use argon2id (`@node-rs/argon2`, ADR 0011) instead of the default scrypt
- **Admin plugin:**
  - Roles are `admin` and `customer` (`createAccessControl`; customers get no admin permissions), with `defaultRole: "customer"`.
  - Accounts are created only through `createUser` (admin UI, access-request approval, seed script).
  - Blocking uses `banUser` / `unbanUser`.
  - `setUserPassword` backs the admin "reset password" action and the CLI seed reset.
- **User `additionalFields`**, all `input: false` (server-owned):
  - `mustChangePassword` (boolean, default `true`)
  - `accessExpiresAt` (date, nullable; null = no expiry)
  - `company`, `country`
  - The planned `status` field is replaced by the admin plugin's `banned` / `banExpires`.
- **Sessions:** stored in the database, so bans and resets revoke them.
  - If the session cookie cache is enabled, its `maxAge` must stay short.
  - Admin authorisation (`requireAdmin()`) and the datasheet route (`requireCustomerAccess()`) always read the session from the database, never the cookie cache.
- **Rate limiting:**
  - Better Auth `rateLimit` with `enabled: true` and `storage: "database"` (memory is useless on serverless).
  - Strict `customRules` for sign-in and the password-reset request.
  - Our per-email counter (ADR 0004) runs in a `hooks.before` on those same paths.
  - Neither is used on whistleblower routes.
  - Set `advanced.ipAddress.ipAddressHeaders` to the header Vercel guarantees; confirm it against Vercel's docs in Phase 1.
- **Telemetry:** off (it is off by default; also set `telemetry: { enabled: false }` explicitly).
- **Secrets:** `secret` and `baseURL` are passed explicitly from `env.auth()` (`AUTH_SECRET`, `AUTH_URL`), so all env handling stays in `src/lib/env.ts` (rule 10). We do not rely on Better Auth reading `BETTER_AUTH_*` variables itself.
- **Next.js:** the route handler is `src/app/api/auth/[...all]/route.ts` via `toNextJsHandler`, plus the `nextCookies()` plugin for Server Actions. Check both against the installed Better Auth docs and Next 16 in Phase 1.

## Consequences
- **Better Auth owns** the `users`, `sessions`, `accounts`, `verifications` and `rateLimits` collections through the raw driver. Our Mongoose code must not write to them.
  - If we need a Mongoose model for admin listings or joins, it is read-only, and its schema must mirror Better Auth's fields.
  - `populate()` across the two worlds is not available; store and query user ids explicitly.
- **Read the installed docs before writing code:** the `better-auth` package's own docs and types in `node_modules` are the reference, not memory, the same rule as for Next.js.
- **Known follow-up:** the comment in `env.auth()` still says "Auth.js infers the URL". It gets fixed in Phase 1 together with `src/lib/auth.ts`.
