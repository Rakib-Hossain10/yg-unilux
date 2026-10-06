# 0031 — Per-user limit on /change-password
- Status: Accepted
- Date: 2026-10-05
- Implements: Phase 1 wrap-up (task-5 QA L1)

## Context
`/change-password` checks the current password. Until now the only limit was Better Auth's per-network rule (10 per 15 minutes per network). An attacker holding a stolen session could use many networks to guess the current password and then take over the account for good.

## Decision
- A hard fixed window of **5 attempts per signed-in user per 15 minutes** (`PASSWORD_CHANGE` in `src/lib/sign-in-limit.ts`). Every attempt counts, right or wrong. The limit is per user, across all of that user's sessions and networks.
- The limit runs in the Better Auth before-hook, **before** the current password is checked. The hook reads the session with `getAuthoritativeSessionFromCtx`, from the database and never from the cookie cache. With no session the hook does nothing, the endpoint answers its own 401, and nothing is counted.
- The key is `user-pw-change:<HMAC-SHA256 of "user-id:" + id>`, made with the same HKDF subkey as the email keys (`hashUserId`). No raw id and no IP is stored.
- A refusal returns the same generic 429 body as every other limit, with `Retry-After`. The audit-log entry is `{ namespace: "user-pw-change", reason: "hard_limit" }`. If the database is down, the limit fails closed with a 503 (ADR 0020).

## Consequences
- A user who makes five legitimate changes in 15 minutes waits for the window to end. That is acceptable for a rare action.
- Each change-password request reads the session twice: once in our hook and once in Better Auth's `sensitiveSessionMiddleware`. This is deliberate, so the session is never passed through.
