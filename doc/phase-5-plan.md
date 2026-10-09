# Phase 5 — Restricted access: implementation plan

Status: **APPROVED** (user, 2026-10-09: all defaults Q0–Q12 accepted, plus Q1 addition: the admin can regenerate an expired or lost invite at any time). Branch `phase-5` (from `main` after Phase 4b, PR #16).

## Scope
The `tasks.md` Phase 5 list, plus the must-dos that earlier phases pushed here:
- **Request access:** a public form and a WhatsApp link. Datasheet buttons and the restricted block link to it.
- **Admin access-request queue:** approve (creates the customer, sets the expiry, sends an invite) or reject.
- **Customers module:** create, extend access, reset password, block or unblock, end sessions, download history, filters.
- **Account flows:** `/login` sends each user to the right place; `/change-password` (forced on a temporary password); `/forgot-password` + `/reset-password` (the admin uses these too); `/my-downloads`; sign out.
- **`/api/datasheet/[productId]`:** the rule-2 chain → a 60 s R2 presigned GET → a `downloadLogs` entry → `private, no-store`.
- **Daily cron:** an expiry reminder 7 days ahead (`CRON_SECRET`, `vercel.json`).
- **Tests:** the access matrix + a Playwright gated-download journey.

**Carried must-dos:**
- ADR 0032 known gap: 24 h cap on the session that `/change-password` replaces. The `it.fails` in `src/lib/remember-me.qa.test.ts` becomes `it`.
- ADR 0064 §14/§19/§45: `/change-password`, temp-password users sent there from `/login`, the download link goes live, and the expired link needs a target.
- Task-5 L3: sign-in, reset and change-password post to `/api/auth/*`, never through server actions. Change-password sends `revokeOtherSessions: true`.
- ADR 0027 note: `/change-password` and any public link into `/admin` are full page loads.
- Phase 2 gate C I-2: encode the file name in `Content-Disposition` (RFC 5987).
- Phase 1 task 5 / ADR 0020: nothing can create an admin with `mustChangePassword: true` until `/change-password` exists. It exists after P2.

**Not in scope:**
- Home page and motion (Phase 6).
- Content pages, including the full `/contact` page (Phase 7; see Q6).
- Whistleblower (Phase 8).
- A second admin or a staff-user screen (CLAUDE.md "Roles").

### About the pasted checklist
The pasted instructions mention filtering, search and menu UI, Viabizzuno, KC Lighting and `withoutRestrictedFilters`. All of that was Phase 4b, which is merged (PR #16). Phase 5 does not touch the listings, the mega-menu or filter storage:
- **Restricted-data rules:** still apply. No new code reads restricted spec values. The download route and account pages are uncached, and nothing new goes into the catalog cache (rule 9, ADR 0002/0062/0063).
- **Motion stack:** Phase 5 has no motion work beyond the existing CSS/reduced-motion conventions, so `motion-engineer` gets no task.
- **Design references:** none of the named ones cover forms or account pages. The account pages follow the existing design shell (ADR 0028): black/white/warm greys and Cormorant + Inter.

## Skills check (`/find-skills`, 2026-10-09)
**Already installed and relevant:**
- `security-and-hardening`: auth flows, untrusted form input.
- `next-best-practices`: route handlers, async APIs, redirects.
- `shadcn`: the admin UI.
- `playwright-best-practices`: email-link flows and downloads.
- `tdd`.
- `web-design-guidelines` and `frontend-design`: forms and account pages.
- `mongodb-connection`.

**Registry results:**

| Skill | Source / installs | Fit |
|---|---|---|
| `better-auth/skills@better-auth-best-practices` | official Better Auth org, ~119K | **Strong.** Phase 5 uses the admin plugin (`createUser`, `banUser`, `setUserPassword`, `updateUser`), reset tokens and session revocation more than any phase so far. |
| `better-auth/skills@better-auth-security-best-practices` | official, ~41K | **Strong.** Covers invite/reset tokens, session revocation and enumeration. |
| `resend/resend-skills@resend` | official Resend org, ~21K | **Medium.** Phase 5 adds 4–5 emails. We already have our own sender (ADR 0021), so this is a reference only. |
| filter / search / combobox / menu UI | only `web-design-guidelines` (installed) or low-install vendor skills (Syncfusion, <1K) | **None.** Nothing to add. |
| cron / presigned S3 | nothing official or relevant (Java/Django S3 skills) | **None.** |

The skill text never overrides the installed `better-auth` 1.7.7 sources. CLAUDE.md says to read those before writing auth code, and every option is checked there as in ADR 0023.

## Subagents
All on Opus (user rule). No new subagent: each Phase 5 job fits an existing role.

| Agent | Phase 5 work |
|---|---|
| `backend-architect` | auth hooks, invite tokens, services, datasheet route, cron, emails, rate limits, models |
| `site-frontend` | account pages, request-access page, product-page CTAs |
| `admin-panel-builder` | access-request queue, customers module, dashboard cards |
| `qa-security-reviewer` | gates A, B and C (access matrix, enumeration, leak checks) |
| `ui-reviewer` | gate C, public pages only (login, forgot/reset, change-password, request access, my-downloads) |
| `code-reviewer` | the hook, on every changed file |
| `motion-engineer` | not used this phase |
| `import-engineer` | not used this phase |

## Context: what exists today
- **`src/lib/auth.ts`** (Better Auth 1.7.7):
  - email/password only, `disableSignUp`, admin plugin (roles admin/customer), argon2id;
  - our per-email/per-network limits on sign-in, reset request and change-password;
  - a device-epoch bump on reset, change-password, set-user-password and ban;
  - reset emails through Resend, with a 1 h token;
  - `additionalFields`: `mustChangePassword` (default true), `accessExpiresAt`, `company`, `country`, `deviceEpoch`; all `input: false`.
  - **Nothing ever sets `mustChangePassword` to false** except `seed:admin`, so a customer would stay on a temporary password forever.
- **`src/lib/permissions.ts`:**
  - `checkDatasheetAccess` (signed in → admin|customer → not banned → password changed → not expired; the admin skips expiry);
  - `requireCustomerAccess()`, `requireAdmin()` (temp password → `/change-password`), `requireAdminForRoute()`.
  - Constants `LOGIN_PATH`, `CHANGE_PASSWORD_PATH`.
- **Datasheet states:**
  - `src/lib/datasheet-state.ts` + `GET /api/catalog/restricted/[productId]` (states download/expired/signin/coming-soon).
  - `datasheet-button.tsx` links to `/api/datasheet/{id}` (404 today), `/contact` (404) and `/login`.
- **Models:**
  - `accessRequests` (name, company, country, email, phone, message, product, source form|whatsapp, status pending|approved|rejected, handledBy/At; index status+createdAt).
  - `downloadLogs` (user, product, datasheet, downloadedAt; indexes user+date, product+date).
  - Read-only `UserModel`.
- **Storage:** `src/lib/storage.ts` has presigned PUT, head, range/bytes, copy and delete. **No presigned GET yet.**
- **Email:** `src/lib/email.ts`: `sendEmail`, `htmlLayout`, `escapeHtml`, `requireSafeLink`, the reset template. `env.email()`, `env.companyEmail()` and `env.cronSecret()` exist. The admin settings hold `companyEmail` and `whatsappNumber` (digits only).
- **Admin:**
  - nav entries `customers` and `accessRequests` already exist in `admin-sections.ts` (404 today);
  - audit vocabulary in `src/models/audit-actions.ts`.
- **Pages:**
  - `(account)` group holds only `/login`. Its form sends admin → `/admin`, everyone else → `/`.
  - No forgot/reset UI.
  - The header Account icon → `/login` (`prefetch={false}`).
- **e2e:**
  - in-memory R2 and Cloudinary fakes (`e2e/fake-providers/`) handle PUT/list/GET of objects, but not presigned GET URLs or Resend;
  - seeded in-memory replica set; shared sign-in state; one worker.

## Decisions to take (defaults in bold; answer or accept)
- **Q0. Skills.** **Install `better-auth-best-practices` and `better-auth-security-best-practices`** (project scope, `.claude/skills/`, ADR 0012/0013 note). Skip `resend`.
- **Q1. How a new customer gets in.** **Invite link, no password in any email.**
  - On approve or create, the account gets a random password that nobody sees, plus `mustChangePassword: true`.
  - The customer receives a "Set your password" link, valid 72 h. It is a Better Auth reset token with a longer expiry, created server-side.
  - Setting the password through the link clears `mustChangePassword`.
  - **Expired or lost invites (user addition, 2026-10-09).** Clients often answer slowly over WhatsApp, so a link that runs out is normal, not an error:
    - **Status:**
      - the customer row shows **"Invite pending"** (link valid, with its expiry time) or **"Invite expired"** (link ran out, password never set);
      - "Invite expired" is its own filter in the customers list (Q10);
      - the dashboard counts "invites expired".
    - **Regenerate:** the admin can make a new invite at any time, as often as needed, from the customer page and from the list row's menu. Each new link is valid 72 h from when it is made.
      - **All earlier invite links for that customer are deleted when a new one is made**, so only one link ever works.
      - The action is rate-limited per customer (10 per hour) against double-clicks, and audited as `customer.invite.resend` (ids only).
    - **Delivery:**
      - **Email it** (default), or
      - **Show it once to copy**, so the admin can paste it into WhatsApp. The link is a credential: it is never stored in readable form, logged or shown again (the same rule as the temporary password).
    - **Approve on an expired invite:** approving a new request from an email whose invite expired re-sends an invite. It never creates a second account.
    - **Customer side:** an expired or used link on `/reset-password` shows "This link has expired. Ask us for a new one", with the WhatsApp button and a link to `/request-access`. It never says whether the account exists.
      - An invited customer can also use `/forgot-password` themselves; the 1 h reset link works the same and also clears `mustChangePassword`.
    - **Expiry of access is separate:** `accessExpiresAt` keeps counting from approval, whatever happens to the invite. Regenerating an invite does not extend access; that stays a separate admin action.
  - Fallback for customers met on WhatsApp: the admin can **set a temporary password, shown once** in the admin UI, for the admin to pass on. The customer is then forced through `/change-password`. A temporary password unlocks nothing until it is changed (permissions already enforce this).
  - Alternative: always a temporary password in the welcome email (simpler, but the password sits in a mailbox).
- **Q2. Access-request form fields.** **Name\*, email\*, company\*, country\* (select), phone, message, product (hidden, from `?product=`), consent checkbox\*** (privacy text, Phase 7 links it).
  - Kind: **"new access" or "renewal"**. A renewal comes from the "Access expired" link; this adds a `kind` field to `accessRequests`.
- **Q3. Anti-spam.** **Honeypot field + minimum fill time (3 s) + per-network limit (HMAC'd IP, 5 per hour) + per-email limit (3 per day)**, all in `loginAttempts` with new namespaces (ADR 0020/0022 pattern).
  - Every request gets the same "Thanks, we'll be in touch" answer, whether it is new, a duplicate, from an existing customer, or blocked as spam. No account enumeration.
  - A second pending request from the same email updates the first. It is never a new row.
  - Cloudflare Turnstile **not now**: it needs a new dependency and CSP changes. Add it later if spam shows up.
  - Launch list: a Vercel Firewall rate limit on the form's POST.
- **Q4. Emails sent.** **Defaults:**
  - **Alert to the company email** on each new request. It holds name, company, country and a link to the queue. It never includes the message text, so the inbox holds less personal data.
  - **Invite** on approve or create.
  - **Expiry reminder** 7 days before.
  - **"Access extended"** when the admin extends access (optional checkbox, on by default).
  - **Rejection: no email by default.** The reject dialog has a "Send a polite decline email" checkbox, off by default.
  - **No acknowledgement email to the requester.** It would let anyone make us email any address.
  - Until a Resend domain is verified, emails reach only the Resend account owner. **User must verify the domain before launch.**
- **Q5. Expiry choices.** **3 / 6 / 12 months, a custom date, or no expiry (null).**
  - Extend counts from the later of today and the current expiry.
  - Expiry is stored as the **end of the chosen day, UTC 23:59:59.999**.
  - The admin UI shows dates in the admin's local time with "UTC" noted.
  - Expired = login still works, downloads are locked (CLAUDE.md).
- **Q6. Where "Access expired — contact us" goes.** **`/request-access?renew=1`**: the same form, kind "renewal", prefilled when signed in.
  - The real `/contact` page stays in Phase 7.
  - Header/footer "Contact" links stay `prefetch={false}` until then.
- **Q7. After sign-in.**
  - **Temporary password → `/change-password`.**
  - **Admin → `/admin`.**
  - **Customer → a safe `?next=` (same-origin path only, no `//`, no scheme), else `/my-downloads`.**
  - "Sign in to download" passes `next=/product/<slug>`.
  - The header Account icon still links to `/login`. `/login` sends an already signed-in user straight on. The header stays static: no session read in the shared shell.
- **Q8. `/my-downloads`.** **Access status** (active until date / no expiry / expired → renewal link), **download history** (newest first, 20 per page, product name + link, file name, date, "Download again"), and **Change password** and **Sign out** buttons.
  - Admins can open it too and see their own history.
- **Q9. Download route answers.** It is a plain `<a>` link, so the answers are:
  - **allowed** → `303` to the presigned URL;
  - **signed out or temporary password** → `303 /login?next=/product/<slug>`;
  - **expired or blocked** → `303 /request-access?renew=1&product=<id>`;
  - **unknown/draft product or no datasheet** → `404`;
  - **over the limit** → `429` page.
  - Every answer is `Cache-Control: private, no-store`.
  - **Per-user download limit: 60 per hour** (stops one account from scraping every datasheet; the admin is exempt).
  - The log entry is written **before** the redirect. If the write fails, the download is refused (fail closed), so the history is complete.
  - The presigned GET sets `ResponseContentDisposition` (RFC 5987 file name) and the xlsx content type.
- **Q10. Customers list.**
  - **Search:** name/email/company.
  - **Status filter:** active / expiring ≤ 30 days / expired / blocked / invite pending (link still valid) / invite expired (link ran out, password never set).
  - **Sort:** expiry, created, name.
  - **50 per page.**
  - **No hard delete.** Blocking keeps the download history and audit trail. A delete needs a privacy decision; Phase 9 can revisit.
- **Q11. Admin daily digest.** **Yes:** the same cron emails the company email a list of customers expiring in 7 days (names + companies + dates), only when there is at least one.
- **Q12. Request data retention.** **Admin can delete a handled request.** No automatic purge now; record the question for the privacy page in Phase 7.

## Security design (CLAUDE.md rules → Phase 5)
- **Rule 2, datasheet route:**
  - Zod on `productId`.
  - Session read from the DB (`getViewer`), then `checkDatasheetAccess`. This is the one shared rule; no copy in the route.
  - Published product → `datasheetId` → datasheet row → `presignGet(key, 60 s)` → `DownloadLogModel.create` → 303.
  - Every branch is `private, no-store`.
  - The R2 key never appears in an answer except inside the signed URL. Logs never print the URL.
  - A static guard test: only this route imports `presignGet`.
- **Rule 3:** every new admin page, layout and Server Action calls `requireAdmin()` first; `test/admin-guards.test.ts` gets new `describe` blocks. Each new action gets a customer/visitor/banned "nothing changed" test (Phase 2 rule).
- **Rule 4:** no self-registration. The request form writes only `accessRequests`. Accounts are created only from the admin (approve or create).
- **Rule 5:**
  - Every password action posts to `/api/auth/*`.
  - Change-password sends `revokeOtherSessions: true`.
  - The after-hooks clear `mustChangePassword`, bump the device epoch (already done) and apply the 24 h cap when `dont_remember` is set (ADR 0032 gap).
  - An invite/reset link proves control of the mailbox; a completed reset also clears `mustChangePassword`.
  - Reset and invite tokens stay hashed (`storeIdentifier: "hashed"`).
- **Writes to `users`:** only through Better Auth (`auth.api.*` admin endpoints, or `internalAdapter.updateUser` for our `input: false` fields inside one server-only helper `src/lib/account-writes.ts`). Never through Mongoose.
  - Spike in P1: whether `auth.api.adminUpdateUser` accepts `input: false` fields. If it does not, use `internalAdapter` via `(await getAuth().$context)`. Check this in the installed sources.
- **Rule 8:** Zod on the form, every action, the route params and the cron.
- **Rule 9:** unchanged. The restricted route keeps its states and gains no new data.
- **Rule 10:** no new env variables. `CRON_SECRET`, `COMPANY_EMAIL`, `RESEND_API_KEY`, `EMAIL_FROM` and `AUTH_URL` already exist. The settings value for company email wins over the env value, as in Phase 2.
- **Enumeration:**
  - forgot-password, the request form and the invite resend answer the same whether or not the email exists;
  - an admin-only screen may say "already a customer".
- **Cron:**
  - `GET /api/cron/access-expiry` checks `Authorization: Bearer ${CRON_SECRET}` with a timing-safe compare, and answers `401` without it.
  - It is idempotent through a new `expiryReminderFor` user field (the `accessExpiresAt` value it reminded about). An extension resets it naturally, and a missed day is caught up.
  - It writes one audit entry with counts only.
  - The response holds no addresses.
- **Proxy:** no change. `/account` pages guard on the server. The geo-block covers the new routes. Vercel Cron does not send a CN country header.
- **Logging:** never log emails, names, tokens, URLs or the request message. Errors log type plus provider code only (ADR 0021 style).

## New and changed data
- `accessRequests`:
  - add `kind: "new" | "renewal"` (default "new");
  - add `user?: ObjectId` (set on approve, or when the request came from a signed-in customer);
  - add `rejectReason?` (admin-only, ≤ 500 characters);
  - add `consentAt: Date`.
  - The index stays. Add `{ email: 1, status: 1 }` for the duplicate-pending merge.
- `users` (Better Auth `additionalFields`, `input: false`): add `expiryReminderFor: date`, `invitedAt: date` and `passwordSetAt: date`. "Invite pending" = invited and never set. The read-only `UserModel` mirrors them.
- `downloadLogs`: unchanged.
- `loginAttempts`: new namespaces `access-request:net`, `access-request:email` and `download:user`.
- Audit vocabulary:
  - admin: `access_request.approve | reject | create_manual | delete`, `customer.create | update | access.set | ban | unban | password.link | password.temp | sessions.revoke | invite.resend`;
  - system: `cron.expiry_reminders`.
  - Meta = ids and counts only, never emails.

## Tasks
Each task gets one commit, green typecheck + lint + tests, and a rewritten Resume section.

| # | Task | Owner | Key files | Tests |
|---|---|---|---|---|
| P0 | Plan approved, answers recorded; skills installed if Q0 = yes (note in ADR 0013) | main | this file, `tasks.md` | — |
| P1 | **Account backend.** Auth hooks: change-password clears `mustChangePassword`, sets `passwordSetAt` and applies the 24 h cap (ADR 0032 gap); a completed reset does the same. `src/lib/account-writes.ts` (one server-only writer for our user fields). `src/lib/invite.ts` (`createInviteLink(userId)`, 72 h, spike first; deletes the user's earlier invite tokens first; `inviteStatus(user)` → none / pending(until) / expired / accepted). `safeNextPath()`. `requireSignedIn()` in permissions. New `additionalFields`. Email templates: invite, expiry reminder, access extended, request alert, decline, admin digest. | backend-architect | `src/lib/{auth,account-writes,invite,permissions,email}.ts`, `src/models/user.ts` | Real Better Auth on the memory DB: temp → change → flag false + sessions revoked + epoch bumped; 24 h cap (`it.fails` → `it`); invite link sets the password and clears the flag, expires at 72 h, is single use; a regenerated link kills every earlier one (old link → expired page, new link works); `inviteStatus` at 71 h 59 m and 72 h; `safeNextPath` property test (`//evil`, `/\evil`, schemes, encoded). Templates escape and validate links. **ADR 0068** |
| P2 | **Account pages.** `/login` destinations (Q7, safe `next`, signed-in users sent on); `/change-password` (posts to `/api/auth/change-password`, `revokeOtherSessions: true`, full page load); `/forgot-password`; `/reset-password` (token from the URL, also used for invites, "Set your password" wording when `?invite=1`); `/my-downloads` (Q8); sign out. All `noindex`, dynamic, no `loading.tsx` around guards. | site-frontend | `src/app/(account)/*`, `src/components/site/account/*`, `login-form.tsx` | Unit tests for destinations; e2e: temp-password customer forced through change-password, then sent on to `next`; forgot → reset with a captured link; axe at 360/1280; no-JS form posts. |
| P3 | **Services.** `src/lib/access-requests.ts` (public `submitAccessRequest`: honeypot, min time, limits, merge duplicate pending, alert email in `after()`); `src/lib/admin/access-requests.ts` (list, approve, reject, manual WhatsApp entry, delete); `src/lib/admin/customers.ts` (list/filter, get + history, create, update profile, set/extend access, ban/unban, send reset link, set temp password shown once, regenerate invite at any time (email it, or return it once for copying; earlier links deleted), revoke sessions). Schemas in `src/lib/schemas/{access-request,customer}.ts`. Audit vocabulary. | backend-architect | above + `src/models/{access-request,audit-actions}.ts` | Memory DB: identical public answers for every case; limits; duplicate merge; approve creates a customer with role customer, `mustChangePassword` true and the expiry; approve for an existing email extends instead (an expired invite is re-sent, never a second account); regenerating an invite leaves `accessExpiresAt` unchanged and is limited per customer; ban kills sessions + epoch; extend math (Q5, end of day UTC); the list status filters; nothing writes `users` through Mongoose. **ADR 0069** (requests), **ADR 0070** (customers) |
| P4 | **Datasheet download.** `presignGet()` in `storage.ts` (60 s, RFC 5987 disposition, content type); `GET /api/datasheet/[productId]` (Q9); per-user limit; log-before-redirect; static guard (only this route imports `presignGet`); R2 fake answers presigned GETs. | backend-architect | `src/lib/storage.ts`, `src/app/api/datasheet/[productId]/route.ts`, `e2e/fake-providers/*` | Access matrix: visitor, customer active / expired / banned / temp password / ban expired, admin, admin on a temp password × product published / draft / unknown / no datasheet / datasheet row missing / bad id → exact status, `Location` and `no-store`. Log written only on success; refused if the log write fails; URL TTL 60 s; non-ASCII file names; limit at 61. **ADR 0071** |
| P5 | **Expiry cron.** `GET /api/cron/access-expiry` (Bearer check, window `now < expiry ≤ now + 7 d` and `expiryReminderFor ≠ accessExpiresAt`, banned skipped, batched, per-user send failure doesn't stop the run, admin digest Q11); `vercel.json` `crons` (daily 08:00 UTC); `npm run cron:expiry -- --dry-run` for local runs. | backend-architect | `src/app/api/cron/access-expiry/route.ts`, `src/lib/expiry-reminders.ts`, `vercel.json`, `scripts/` | 401 without or with a wrong secret (length-mismatch safe); idempotent (second run sends 0); an extension re-arms it; a missed day is caught up; null expiry and expired users skipped; the response has no emails. **ADR 0072** |
| — | **QA gate A** (P1–P5): access matrix, enumeration, token handling, cron auth, no writes to `users` outside Better Auth, `no-store` everywhere, logs free of personal data | qa-security-reviewer | `test/*phase5-gate-a*.qa.test.ts` | — |
| P6 | **Request access UI.** `/request-access` (Q2, `?product=`, `?renew=1`, prefill when signed in, no-JS POST via a Server Action that only calls `submitAccessRequest`); WhatsApp button (`wa.me/<digits>?text=` prefilled with the product name; hidden when no number is set); datasheet button + restricted block link here ("Request access" next to "Sign in", expired → renewal). Restricted-block copy changes stay value-free. | site-frontend | `src/app/(site)/request-access/*`, `src/components/site/product/{datasheet-button,restricted-block}.tsx` | e2e: submit (no JS too), honeypot, same answer twice, the product links; axe; the restricted-block leak tests still green. |
| P7 | **Admin access-request queue.** `/admin/access-requests`: tabs pending/handled, row detail, approve dialog (Q5 expiry picker, editable name/company/country, "existing customer" notice → extend), reject dialog (reason + optional email), manual WhatsApp entry, delete handled; pending count on the dashboard. | admin-panel-builder | `src/app/admin/access-requests/*`, `src/components/admin/access-requests/*` | Action guard tests (customer/visitor/banned nothing changed); e2e approve → customer exists + invite captured; axe; 375 px. |
| P8 | **Admin customers module.** `/admin/customers` (Q10 list) + `/admin/customers/new` + `/admin/customers/[id]` (profile, access card with extend/custom/none, password card: send reset link / set temporary password shown once, block/unblock with reason, end sessions, invite card (status pending-until / expired / accepted + "New invite link" with "Email it" or "Show once to copy"), download history, linked requests, audit trail); dashboard "expiring in 30 days" card. | admin-panel-builder | `src/app/admin/customers/*`, `src/components/admin/customers/*` | Guard tests; e2e create → invite → clock past 72 h → "Invite expired" shown + filter → new link (copy mode) → old link shows the expired page, new link sets the password → extend → block → sessions gone; the copied link is not in the page after reload; unknown id 404 (no `[id]/loading.tsx`, gate A L-1 lesson); axe. |
| — | **QA gate B** (P6–P8): the full admin guard sweep, temp password shown only once and never logged, form abuse, restricted-block leak test re-run | qa-security-reviewer | `e2e/*phase5-gate-b*.qa.spec.ts` | — |
| P9 | **Exit e2e.** The whole journey: request → approve → invite email captured by a Resend fake → set password → download (presigned GET served by the R2 fake, log row) → admin sets expiry in the past → button says expired, the route redirects to renewal → cron run sends the reminder once. Plus Lighthouse/axe on the account pages. | qa-security-reviewer + site-frontend | `e2e/restricted-access.spec.ts`, `e2e/fake-providers/` (Resend sink) | — |
| — | **Gate C:** `qa-security-reviewer` (whole phase vs CLAUDE.md, `npm audit`, gitleaks), then `ui-reviewer` (public account/request pages, 360–1920, reduced motion) | both | — | — |

QA gates: **A after P5, B after P8, C at exit.** Every changed file also gets the automatic `code-reviewer` pass.

## ADRs to write
- **0068:** account flows (destinations, safe `next`, change-password flag + 24 h cap, invite token = long-lived reset token, `passwordSetAt`/`invitedAt`, one user-field writer).
- **0069:** access requests (fields, kind, anti-spam, duplicate merge, identical answers, emails, retention).
- **0070:** customers module (writes only through Better Auth, status model, expiry math, no hard delete, temporary password shown once).
- **0071:** datasheet download route (answers per state, presigned GET, log-before-redirect, per-user limit, static guard).
- **0072:** expiry reminder cron (Bearer auth, idempotency field, digest, schedule).
- **Note on 0032:** gap closed.

## Things the user must do
- Answer or accept Q0–Q12.
- **Resend:** verify the sending domain and set `EMAIL_FROM` before launch. Until then, invites and reminders reach only the Resend account email, which is enough for dev testing.
- Set `COMPANY_EMAIL` (or the admin setting) and the WhatsApp number in `/admin/settings`.
- `CRON_SECRET` (32+ random characters) in `.env.local` now. In Vercel later, Vercel sends it automatically to cron routes.
- After P1: `npm run db:indexes` on the dev DB (new `accessRequests` index).
- Launch list additions: Vercel Firewall rate limits on `POST /request-access` and `/api/datasheet/*`; check the cron in the Vercel dashboard after the first deploy.

## Risks
- **Invite token reuse of Better Auth's reset mechanism (Q1):** if 1.7.7 does not accept a custom-expiry verification row, P1 falls back to our own invite-token table (hashed, 72 h, same regenerate rules). The regenerate feature stays either way. The spike decides before any UI depends on it.
- **`input: false` fields through the admin API:** spike in P1 (see Security design).
- **Email in e2e:** a Resend sink must be added to the fake providers (P2 needs it for the forgot-password test, so P1/P2 build it).
- **The single admin on a temporary password:** after P2 this is safe (`requireAdmin` → `/change-password`). The seed script keeps `mustChangePassword: false` as today.
