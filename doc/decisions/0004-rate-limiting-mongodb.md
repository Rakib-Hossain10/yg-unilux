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

## Consequences
- One extra DB write per login attempt; acceptable at this traffic.
- Stored IPs expire automatically with the TTL.
