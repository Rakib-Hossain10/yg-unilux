# 0020 — Per-email rate limiter
- Status: Partly superseded by ADR 0022 (sign-in now uses per-network limits, a slow-down and known devices; item (c) is resolved there). Reset requests still follow this ADR until task 5.
- Date: 2026-10-02
- Builds on: ADR 0004 (and its update), 0017

## Decision
- **`src/lib/rate-limit.ts`** is a fixed-window counter on `loginAttempts`.
  - It is one atomic `findOneAndUpdate` update pipeline using the database clock (`$$NOW`). A window that has ended is reset atomically even before the TTL monitor deletes the document.
  - QA verified the "exactly `limit` allowed" behaviour under 40-way parallel calls on 10 keys.
- **Rules:** `LOGIN_EMAIL` allows 5 attempts per 15 minutes; `RESET_EMAIL` allows 3 requests per hour.
- **Keys:** `<namespace>:HMAC-SHA256(trim+lowercase(email))`.
  - The HMAC key is a **subkey** derived from `AUTH_SECRET` (HKDF-SHA256, info `yg-rate-limit-v1`), so the session-signing secret is never reused directly for this.
  - No plain email or IP is stored or logged, and errors never contain the key.
  - The email is capped at 254 characters before hashing.
  - QA confirmed the normalisation matches Better Auth 1.7.7: `z.email()` is ASCII-only, followed by `toLowerCase()`.
- **Gate with `consume()` only:** call `consume()` before the sign-in or reset (it counts and decides atomically), and `clearAttempts()` after a successful sign-in. `checkLimit()` is for display only: check-then-record is raceable (QA M1).
- **Fail closed:** if the database fails, `RateLimitUnavailableError` is thrown and the caller answers with a generic "try again later". It leaves no persistent state.

## Known risk: an attacker can lock out a victim (QA M2)
Five wrong passwords every 15 minutes for one email keep that account locked, including the single admin. Three reset requests an hour use up the victim's reset emails.

Mitigations, required in later tasks:
- **(a)** `seed:admin` (task 7) also clears the admin's `email-login` and `email-reset` counters, so a CLI reset always gets the admin back in.
- **(b)** A successful password reset clears the login counter (task 5).
- **(e)** The 429 response is generic and identical whether or not the account exists. Unknown emails are counted too, so the limiter doesn't reveal which accounts exist (task 5).
- **(f)** Lockouts are written to `auditLog` with the hashed key only (task 5).
- **(c) Pending user decision:** a per-(email + hashed IP) key at 5 per 15 minutes, plus a looser per-email key (about 20 per 15 minutes). One attacker IP then couldn't lock out a user signing in from another network.
  - Stores only an HMAC of the IP, deleted by TTL, and is never used on whistleblower routes.
  - The alternative is to accept the risk, mitigated by (a) and (b).

## Consequences
- **Phase 8:** the whistleblower lockout per case number adds its own namespace and key builder (`wb-case:`), never keyed by IP.
- **The unique `key` index must exist in every environment** (`npm run db:indexes`). Without it, concurrent upserts could create duplicate counters.
