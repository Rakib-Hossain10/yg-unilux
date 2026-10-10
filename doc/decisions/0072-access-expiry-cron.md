# 0072 — Access-expiry reminder cron
- Status: Accepted
- Date: 2026-10-10

## Context
Plan Q4/Q11 and P5: a customer whose datasheet access ends soon gets one reminder 7 days ahead, and the company inbox gets a daily digest. Vercel Cron calls a route once a day, with no retries and no ordering guarantee. A run can be missed, two runs can overlap (a manual CLI run during the cron), the email provider can fail for one customer, and the admin can extend access at any time. `users` is owned by Better Auth and written only through `account-writes.ts` (ADR 0068). Logs and the audit log never hold personal data.

## Decision
1. **Route.** `GET /api/cron/access-expiry`, Node runtime, `maxDuration` 300, `await connection()`, so it always runs per request and is never cached.
   - **Auth:** the `Authorization` header is first checked with Zod: `Bearer <printable ASCII>`, at most 7 + 505 characters. Both the header and `Bearer ${CRON_SECRET}` are hashed with SHA-256 and compared with `timingSafeEqual`, so the length is never compared directly. Anything else, or a missing `CRON_SECRET` (logged by type), gets 401 and nothing runs.
   - **Answers:** 200 counts / 409 `{status:"busy"}` / 503 `aborted` with counts / 503 `{error:"unavailable"}`. All are JSON with `private, no-store` and `nosniff`. The body is an allowlist of counts: no addresses, names or ids.
2. **`CRON_SECRET` rule** (`env.ts`): 32–505 printable ASCII characters, no spaces. It matches what the header check accepts, so a bad secret fails when the env is read, not as a silent 401.
3. **Who is due** (`dueFilter`):
   - customers only, never the admin (`CUSTOMERS_ONLY`);
   - not blocked (no ban, or `banExpires <= now`, as `isBanned`);
   - `now < accessExpiresAt <= now + 7 d`;
   - `$expr: expiryReminderFor != accessExpiresAt`.

   Null expiry and expired users are out. Invite-pending customers are included.
4. **Idempotency.** After a successful send, `expiryReminderFor = accessExpiresAt`, through `updateAccountFields` only. A later run finds nobody. An extension changes `accessExpiresAt`, so the customer is due again before the new date. A missed day is caught up because the window covers the whole 7 days.
5. **One run at a time.**
   - A global lock: `acquireLock` with an owner token, namespace `cron-lock`, key = SHA-256 of the job name, 330 s, longer than any run. A run that finds the lock held does nothing and answers `busy`. The lock is released in `finally`.
   - Each reminder also carries a Resend `Idempotency-Key` `expiry-reminder/<userId>/<expiryMs>`. A run that outlived its lock, or a retry after a failed mark write, can't send twice within Resend's 24 h key window.
   - Not a per-user conditional claim: the only sanctioned `users` writer cannot do a conditional update.
6. **Batches and budget.**
   - 50 per query, soonest expiry first, customers already tried excluded with `$nin`, so each is tried once per run.
   - Sequential sends with 600 ms between them (Resend's 2 requests per second).
   - No new send starts after 240 s (`truncated`). Anyone not reached is reminded the next day.
7. **Failures.**
   - A failed send is counted (`failed`), left unmarked and retried on the next run.
   - Sent but the mark failed: counted (`markFailed`); the Resend key prevents a duplicate within 24 h.
   - A failed batch read ends the run as `aborted`. The digest and audit entry are still written for what was done.
   - Failures before any send (lock, Better Auth context, the count) reject, and the route answers 503.
   - Logs hold the error type plus the email failure reason, status and provider code only.
8. **Digest (Q11).**
   - One email to `getCompanyAlertEmail()` (the setting wins over `COMPANY_EMAIL`) listing name, company and expiry date of the customers reminded in this run, so each customer is in exactly one digest.
   - Sent only when at least one customer was reminded, through the existing `sendExpiryDigestEmail` (escaped, capped at 200 rows).
   - Idempotency key: `expiry-digest/<UTC day>/<hash of the sorted ids>`.
   - Tried twice. A digest still lost is accepted and recorded as `digest:"failed"`: those customers are already marked, and the customers list's "expiring" filter still shows them.
   - No recipient → `no_recipient`.
9. **Audit.** One `cron.expiry_reminders` entry per real run (not for a dry run or a busy run), no actor and no target. Meta: `due`, `sent`, `failed`, `markFailed`, `truncated`, `aborted`, `digest`. Counts only.
10. **Schedule.** `vercel.json` `crons`: `/api/cron/access-expiry` at `0 8 * * *` (08:00 UTC daily).
11. **CLI.** `npm run cron:expiry` runs the same service.
    - Dry run by default (`--dry-run` says so explicitly): a count only, with no lock, email, write or audit.
    - `--send` runs the job with its own Better Auth context.
    - Output is counts only. Exit code 1 on busy, aborted, or any failed or unmarked reminder.

## Consequences
- `proxy.ts` is unchanged: the cron path has no admin redirect, and Vercel Cron sends no `CN` country header.
- After the first deploy, check the cron in the Vercel dashboard (launch list). Vercel sends `CRON_SECRET` to cron routes automatically.
- `users` has no index on `accessExpiresAt`. Fine at the expected customer count; add one through `syncBetterAuthIndexes` if it grows.
- A customer renamed on the same day as a failed mark write gets a Resend 409 for the reused key. The retry is counted as failed, and nothing is sent twice; it clears after 24 h.
- Tests: `src/lib/expiry-reminders.test.ts`, `src/app/api/cron/access-expiry/route.test.ts`, `scripts/cron-expiry.test.ts`.
- Gate A: review the cron auth, the counts-only body and audit, and the lock and idempotency reasoning.

## Amendment (2026-10-10, QA gate A, user decision)
- A customer who never accepted their invite gets no expiry reminder. "Never accepted" means `invitedAt` is set and `passwordSetAt` is missing or earlier than `invitedAt`, the same rule as the invite pending/expired status.
- `dueFilter` adds `INVITE_SETTLED` (exported from `customers.ts`): `{ $or: [{ invitedAt: null }, { $expr: { $gte: ["$passwordSetAt", "$invitedAt"] } }] }`.
- Once the customer sets a password through the invite, they are due on the next run. If that is still before the expiry, they get their one reminder for that date.
- The digest and the audit counts are unchanged; `due` already excludes these customers, so there is no "skipped" count.
