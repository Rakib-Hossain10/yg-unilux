# 0032 — "Keep me signed in", off by default, for every role
- Status: Accepted
- Date: 2026-10-05
- Decided by: the user

## Context
`login-form.tsx` sent `rememberMe: true` on every sign-in. Every session, the admin's included, therefore got a 7-day cookie, even on a shared or borrowed computer.

## Decision
- `/login` has a "Keep me signed in" checkbox. It is **unchecked by default**. The admin and customers get exactly the same behaviour, with no special case by role.
- **Unchecked** sends `rememberMe: false`. Better Auth sets a session cookie without `Max-Age` or `Expires`, so it ends when the browser closes. It also sets the signed `dont_remember` cookie and writes the database session with `expiresAt` = now + 24 hours (`internal-adapter.mjs:271`). It never refreshes such a session (`session.mjs:170`). So 24 hours is a hard cap on the server, even if the browser restores cookies on restart.
- **Checked** sends `rememberMe: true` and keeps the existing 7-day cookie and session, which refresh as before.

## Consequences
- Signing in by default no longer outlives the browser or a day. Users who want 7 days must tick the box each time they sign in.
- Tests: `auth.qa.test.ts` covers both server-side cookie shapes. The e2e test `auth-access.spec.ts` checks that the box is unchecked by default and that the cookie is session-only, and that checking it gives about a 7-day cookie.

## Known gap (QA, 2026-10-05)
The 24-hour cap does not hold after `/change-password` with `revokeOtherSessions: true`. Better Auth creates the replacement session without the don't-remember flag (`update-user.mjs:176`), so the server stores it for 7 days. The cookie stays session-only and the session is never refreshed. A user who unchecked the box and then changes their password can therefore stay signed in for up to 7 days if their browser restores session cookies.
- `src/lib/remember-me.qa.test.ts` pins this with an `it.fails` test. Turn it into a plain `it` once fixed.
- Fix before the Phase 5 change-password UI ships: in the `/change-password` after-hook, if the signed `dont_remember` cookie is present and a new session was issued, set that session's `expiresAt` to now + 24 hours.
