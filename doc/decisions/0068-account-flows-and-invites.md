# 0068 — Account flows: password-change flag, invite links, one user-field writer
- Status: Accepted
- Date: 2026-10-09

## Context
Phase 5 (plan Q1, Q7, user addition on expired invites) needs:
- a temporary password to stop counting once it is changed;
- customers invited without a password in any email;
- invites that can be regenerated when the 72 h link runs out;
- safe `?next=` redirects after sign-in.

The P1 spikes checked better-auth 1.7.7 in `node_modules`. Before P1, nothing cleared `mustChangePassword` except `seed:admin`. ADR 0032's known gap (24 h cap lost after change-password) was still open.

## Decision
1. **An invite is a Better Auth reset token with a 72 h expiry.**
   - `src/lib/invite.ts` `createInviteLink(userId)` creates a `reset-password:<32 random bytes, base64url>` verification row through `internalAdapter.createVerificationValue`. It is stored hashed (`storeIdentifier: "hashed"`, `dist/db/verification-token-storage.mjs:4-13`).
   - The normal `POST /api/auth/reset-password` consumes it. `consumeVerificationValue` is atomic and single-use (`dist/db/internal-adapter.mjs:787-857`). An expired, used or unknown token gives the same `400 INVALID_TOKEN`.
   - The row's expiry is 1 ms before `inviteExpiresAt`, so "valid" is exactly `now < inviteExpiresAt` for both Better Auth and our status.
   - Link: `${AUTH_URL}/reset-password?token=<t>&invite=1` (`RESET_PASSWORD_PAGE_PATH`).
2. **Only one link works per user.**
   - Identifiers are hashed, so a user's rows are found by `verifications.value = userId`. With our disabled paths and plugins, only reset and invite tokens use that value.
   - A new invite deletes every other row of the user by id.
   - A successful reset or change-password deletes all of them.
   - A new invite therefore also kills a pending 1 h forgot-password link, and vice versa.
3. **Invites go only to customers.**
   - Regenerating never changes `accessExpiresAt` or `mustChangePassword`.
   - Running it twice at once for the same user can at worst leave a dead link, never two live ones.
   - Regenerate rate-limiting and the admin UI come in P3/P8.
4. **New `additionalFields`**, all `type: date`, `input: false`, `returned: false`: `invitedAt`, `inviteExpiresAt`, `passwordSetAt`, `expiryReminderFor`.
   - `inviteExpiresAt` exists because the hashed rows can't be looked up per invite.
   - The adapter **silently drops undeclared keys** (`@better-auth/core/dist/db/adapter/factory.mjs:104-115`), so a memory-DB test reads every allowlisted field back from the raw document.
5. **`inviteStatus(user, now)`** is pure:
   - `none` | `pending(until)` | `expired(expiredAt)` | `accepted`;
   - accepted = `passwordSetAt >= invitedAt`, which also covers a password set through `/change-password` after the invite;
   - a missing or unreadable expiry counts as expired (fail closed).
6. **One writer.**
   - `src/lib/account-writes.ts` is the only code that writes our user fields (`internalAdapter.updateUser` behind a strict Zod allowlist) and the only code that deletes verification rows.
   - `auth.api.adminUpdateUser` is not used: it needs an admin's request headers, which hooks, the cron and the CLI lack.
   - A guard test enforces both rules in `src/` and `scripts/`.
   - `seed:admin` goes through `recoverAdminFromCli`.
7. **After-hooks; failures are thrown, never swallowed.**
   - `/change-password` steps, in order:
     1. cap the new session at 24 h when the signed `dont_remember` cookie came with the request (closes ADR 0032's gap; a password change restarts the 24 h clock);
     2. delete the user's links;
     3. one atomic write: `mustChangePassword: false` + `passwordSetAt` + device epoch + 1;
     4. set a fresh device cookie.
   - `/reset-password`: delete links → the same atomic write → clear counters (a failure there is only logged) → device cookie.
   - The flag write comes last, so a failure leaves the flag true and the user retries. It can never leave "flag cleared, old links alive".
8. **`safeNextPath(raw)`** (`src/lib/safe-next-path.ts`):
   - accepts printable ASCII only, ≤ 512 characters, exactly one leading `/`;
   - checks every percent-decoded layer (up to 4) for `//`, `\`, whitespace and control characters;
   - finally checks that the URL parser keeps the same origin.
   - Encoded whitespace is refused on purpose, so a `next` with `%20` falls back to the default page.
   - `loginPathFor(path)` builds `/login?next=`.
   - `requireSignedIn(nextPath)` redirects signed-out users only. Temporary-password users are not redirected by it; callers decide.
9. **Emails** (invite, expiry reminder, access extended, request alert, decline, admin digest):
   - links are built from `AUTH_URL`, and the invite link must be same-origin;
   - dates are spelled out in UTC;
   - text from the public form (name, company, country) is defanged (`[:]//`, `[at]`, `[.]`) in the alert, greetings and digest;
   - the alert never carries the request message.
   - `requireSafeLink` also accepts `http://localhost` in a production build only when it equals `AUTH_URL`, so the e2e build can send mail; a real deployment uses https.
10. **e2e email sink:** the provider preload wraps `fetch` for `api.resend.com` only and records messages in the loopback fake server (`GET`/`DELETE /__e2e/emails?to=`).
    - Helpers: `waitForEmail`, `linkIn` (`e2e/fixtures/emails.ts`).
    - Email specs use the dedicated `E2E_MAIL_CUSTOMER`, so they never use up another account's reset quota.

## Consequences
- P2 pages:
  - `/reset-password` reads `token` and `invite`, then POSTs `{token, newPassword}` to `/api/auth/reset-password`.
  - On success all sessions are gone, so it sends the user to `/login?reset=1`.
  - On `INVALID_TOKEN` it shows the neutral "This link has expired. Ask us for a new one" page.
  - Forgot-password posts `{email, redirectTo: "/reset-password"}`.
- ADR 0032's gap is closed; `remember-me.qa.test.ts` asserts it with a plain `it`.
- **Accepted limit:** the device-epoch bump is read-then-write. A device token issued during a concurrent ban or set-password can survive, but it only chooses the sign-in rate-limit path, never access.
- **Open for P3:** decide whether the admin's "set temporary password" also sets `mustChangePassword: true` and deletes invite links (expected: yes). The "invite expired" list filter needs a `$expr` comparing `passwordSetAt` and `invitedAt`. The request form's Zod should keep name, company and country to a short plain character set.

## P2 addendum (2026-10-09, account pages)
1. **Destination rule** `destinationAfterSignIn` (`src/lib/account-destination.ts`, pure, used by the login form and the server pages):
   - anything but an explicit `mustChangePassword: false` → `/change-password` (carrying `?next=`); fails closed;
   - admin → `/admin`, never `next`;
   - everyone else → a safe `next`, else `/my-downloads`.
   - `accountNextPath` = `safeNextPath` + refuses `/login`, `/change-password`, `/forgot-password`, `/reset-password`, `/api` (no loops, no JSON destinations).
   - A signed-in user on `/login` gets a server `redirect()`. The DB is read only when a session cookie is present; a failed read shows the form.
2. **Guards:** `/change-password` = `requireSignedIn()`; `/my-downloads` = `requireSignedIn("/my-downloads")`. No `loading.tsx`. Every account page is dynamic + noindex except `/forgot-password`, which is static (nothing per visitor).
3. **Full page loads:** the header Account icon is a plain `<a href="/login">` (it may land on `/admin`, ADR 0027). Sign out POSTs `/api/auth/sign-out`, then `location.replace("/")`; on failure it stays with an alert.
4. **Reset page** (`resetPageState`): any `error` param, a missing/repeated token, or a token not matching `^[A-Za-z0-9_-]{16,128}$` → expired view without a round trip; `invite=1` → "Set your password". A 400 `INVALID_TOKEN`/`USER_NOT_FOUND` swaps in the same view. Success → `/login?reset=1`. The expired view never says whether the account exists; WhatsApp only when a number is set.
5. **Referrer:** `/reset-password` metadata `referrer: "no-referrer"`, links `rel="noreferrer"`, fetch `referrerPolicy: "no-referrer"`. The token is never logged or copied into another URL. A `Referrer-Policy` response header for this path is an optional second layer (not done).
6. **Forms:** `method="post"` with no action (ADR 0029), so a no-JS submit never puts a secret in the URL; they need JS to work. New password asked twice (browser-only match), 12–128 characters, must differ from the current one. One 429 text. A 401 on change-password → "session ended" + sign-in link.
7. **History reader** `getDownloadHistory(userId, page)` (`src/lib/download-history.ts`): `countDocuments` + `find().lean()` with projection, sort `{downloadedAt:-1,_id:-1}`, then one `$in` each for products and datasheets; 20 per page, page 1–1000, past the end → last page; no spec values or storage keys (tested); called only with the session's own id. "Download again" only when the viewer can download now and the product is published with a datasheet; drafts "(no longer listed)", deleted products "A product that has been removed".
8. **Access line** `accessStatus` (on `checkDatasheetAccess`): admin / active until / no end date / ended (→ `/request-access?renew=1`) / paused / none; UTC dates.
9. **WhatsApp:** `src/lib/contact-settings.ts` (`getWhatsappNumber`, `whatsappLink`): uncached, fails soft to null, `wa.me` links only from 8–15 digits. P6 reuses it.
10. **e2e:** new accounts `E2E_TEMP_CUSTOMER`, `E2E_READY_CUSTOMER`, `E2E_EXPIRED_CUSTOMER`; `E2E_SEEDED_CUSTOMERS` drives the dashboard count (P1 had silently broken `admin-shell.spec.ts`).
