# 0030 — Auth responses: no session tokens in JSON, client aborts are a quiet 499
- Status: Accepted
- Date: 2026-10-04
- Implements: Phase 1 wrap-up (task-12 QA Lows)

## Context
- Better Auth echoes the session token in JSON bodies: `/sign-in/email` and `/change-password` (top-level `token`), `/get-session` (`session.token`), `/list-sessions` (each entry). The HttpOnly session cookie already carries it. Any copy in a JSON body can be read by page scripts, for example by an XSS payload calling `fetch("/api/auth/get-session")`.
- A browser that closes the connection mid-request (Node's `Error: aborted`, code `ECONNRESET`, while reading the body) was logged as `[auth] request failed: Error` with a 500. It looked like a server fault, which it is not.
- `e2e/test-server.ts` passed only some variables to `next start`. `@next/env` then filled the rest from the developer's `.env.local`, including real Resend, Cloudinary, R2, whistleblower and cron secrets (rule 11).

## Decision
- `src/lib/auth-handler.ts` removes every `token` key, at any depth, from each JSON body under `/api/auth/*`. Bodies that are not JSON or not valid JSON pass through unchanged. Server code reads sessions through `auth.api`, which never goes through this handler.
- The handler answers a client abort with **499** (no body, `private, no-store`) and logs it only through `console.info`. A request counts as a client abort only when `request.signal.aborted` is true or the error is exactly `Error("aborted")` with code `ECONNRESET`. An `ECONNRESET` or `AbortError` from an outgoing call (MongoDB, Resend) stays a logged 500.
- The e2e server starts every variable named in `.env.example` as `""`. The list is read from the file, so a new variable cannot be missed. `@next/env` keeps keys that already exist, and `env.ts` treats `""` as unset. Test values are then set on top. A Next crash by signal exits 1.
- The sign-out button leaves the page only when the server answers OK. Otherwise it shows an error, so nobody walks away believing they are signed out.

## Consequences
- `/revoke-session` (revoke by token) cannot be fed from `/list-sessions` over HTTP. Revoking other sessions uses `/revoke-other-sessions` (or `revokeOtherSessions: true` on change-password). A future "your devices" screen would need a server action that uses `auth.api` and session ids.
- Every JSON auth answer is buffered and re-serialised. These answers are small, so the cost is negligible.
- A new test pins the 499 behaviour. `sign-in-concurrency.qa.test.ts` now expects 499 and no error log.
