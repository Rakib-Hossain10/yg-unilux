# 0004 — Login rate limiting with MongoDB
- Status: Accepted
- Date: 2026-09-30

## Context
Serverless instances share no memory, so an in-memory limiter does not work. We do not want to add Redis/Upstash.

## Decision
- Internal collection `loginAttempts` with a counter per key and a TTL index on `expiresAt`.
- Two keys per attempt: `email:<normalised email>` and `ip:<ip>`. Either over its limit → reject.
- Applied to login and password-reset request endpoints.
- **Never** applied to whistleblower routes (no IP may be stored there — CLAUDE.md rule 7).

## Update 2026-10-01 (ADR 0017)
With Better Auth, the **per-IP** limit uses Better Auth's built-in `rateLimit` (`storage: "database"`, strict `customRules` on sign-in and password-reset requests). Our MongoDB TTL counter in `loginAttempts` keeps only the **per-email** key, checked in a Better Auth `hooks.before` on the same paths. Better Auth's limiter is keyed by IP only.

## Update 2026-10-02 (ADR 0022)
Sign-in is now limited per (email + HMAC'd network) and per known device, plus a per-email slow-down; see ADR 0022. Better Auth's built-in limiter stores raw IPs, so task 5 must give it HMAC'd storage or turn it off for those paths.

## Consequences
- One extra DB write per login attempt; acceptable at this traffic.
- Stored IPs expire automatically with the TTL.
