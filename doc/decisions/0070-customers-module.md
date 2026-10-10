# 0070 — Customers module
- Status: Accepted
- Date: 2026-10-09

## Context
The admin creates customers, sets and extends their access, blocks them, resets their passwords and re-issues invite links (Q1, Q5, Q10). Better Auth owns `users`, and Mongoose must never write it (ADR 0017/0019).

## Decision
1. **Writes to `users`.** These go only through Better Auth admin endpoints called with the admin's own headers, or through `src/lib/account-writes.ts`.
   - The endpoints are `createUser` (role, `mustChangePassword`, expiry, company and country in one insert), `banUser`, `unbanUser`, `setUserPassword`, `revokeUserSessions` and `requestPasswordReset`.
   - `name` is added to the `account-writes` allowlist.
   - Three guard tests enforce this.
   - `updateCustomerProfile` and `setCustomerAccess` write through `account-writes`, so the action's `requireAdmin()` is their only role check.
2. **Status model.**
   - Access is `no_expiry`, `active`, `expiring` (30 days or less) or `expired`.
   - Blocked means banned with no end, or with an end still ahead.
   - "Invite pending" and "invite expired" use a `$expr` on `passwordSetAt >= invitedAt` together with `inviteExpiresAt` compared to now.
   - The list shows customers only; admin accounts are excluded.
   - Search covers name, email and company, regex-escaped. The list sorts by expiry, created or name, 50 per page.
3. **Expiry math (Q5)** lives in `src/lib/access-expiry.ts`.
   - Month presets (3, 6 or 12) count from the later of now and the current end, clamp at the month end, and store the end of the UTC day (23:59:59.999).
   - A custom date is stored as the end of that UTC day. A past day is allowed and ends access.
   - `none` stores null.
   - The "access extended" email goes out only when access actually grew and the customer is not blocked (`accessGrew`).
4. **No hard delete.** Blocking keeps the history and the audit trail.
5. **Temporary password.** It is 16 characters with no look-alike characters, and it is returned once.
   - Before it is set, `mustChangePassword` becomes true and the invite fields and links are cleared.
   - Then sessions are killed and the device epoch is bumped.
6. **Invite regenerate** works at any time, by email or as a link shown once to copy. Earlier links die, and `accessExpiresAt` never changes.
   - Limits: 10 per hour per customer (`invite-user`), and an in-flight lock (`invite-lock`, 30 s).
   - The lock is an atomic pipeline on the database clock with an owner token, so a holder whose lock ran out cannot free someone else's.
   - Regenerating is refused while the customer is blocked.
7. **Ban** takes a reason. It kills sessions and bumps the device epoch.
8. **Audit:** `customer.create | update | access.set | ban | unban | password.link | password.temp | sessions.revoke | invite.resend`, plus the system entry `cron.expiry_reminders` (no actor; the `cron.*` prefix). Meta holds ids, kinds, states and counts only, and a test checks it holds no `@` and no names.
   - **Exception to ADR 0035 point 5:** a result that carries a one-time credential (temporary password or copy link) returns `ok` with `auditFailed: true` (`auditKeepingData`) when the audit write fails. Losing the credential would be worse. The UI shows `AUDIT_FAILED_MESSAGE`.

## Consequences
- Service API for P8 (`@/lib/admin/customers`): `listCustomers`, `getCustomer`, `getCustomerCounts`, `createCustomer`, `updateCustomerProfile`, `setCustomerAccess`, `banCustomer`, `unbanCustomer`, `revokeCustomerSessions`, `sendCustomerResetLink`, `setTemporaryPassword` and `regenerateInvite`.
- The UI must show `invite.url` and `password` once, and never put them in a URL or a log.
- `test/helpers/auth-harness.ts` runs real Better Auth on the memory database for later tests.

## Amendment (2026-10-10, ADR 0076)
Expiry days and month presets now end at the end of the **China-time** day (`src/lib/time-zone.ts`), not the UTC day.
