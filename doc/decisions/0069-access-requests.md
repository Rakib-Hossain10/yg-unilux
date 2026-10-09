# 0069 — Access requests
- Status: Accepted
- Date: 2026-10-09

## Context
Phase 5 (Q2, Q3, Q12) lets visitors ask for datasheet access through a public form. The admin also logs requests that came in on WhatsApp, and approves or rejects them. Rule 4 means no self-registration. The form must not reveal who is a customer, and it must resist spam without CAPTCHAs.

## Decision
1. **Fields.** Name, email, company and country are required. Each uses a short plain character set: letters in any script plus simple punctuation, and no `:`, `@`, `<`, `>` or line breaks. Phone, message and a published-product reference are optional. Consent is required and stored as `consentAt`. Manual (WhatsApp) entries carry no consent.
2. **Kind and links.** `kind` is `"new" | "renewal"`. `user` is set on approval, or at submission when a signed-in customer uses their own email. `rejectReason` is admin-only and at most 500 characters.
3. **Anti-spam.** A honeypot field (`website`) and a 3-second minimum fill time (`startedAt`, rendered by the server) are checked before Zod, so bots get no feedback.
   - Per network: 5 per **15 minutes**, not the plan's 5 per hour. ADR 0022 says IP-derived records must be gone within 15 minutes.
   - Per email: 3 per day.
   - A missing IP header falls back to a per-email network bucket.
   - The namespaces are `access-request-net` and `access-request-email`. The key pattern forbids a second colon.
4. **One pending request per email.** A unique partial index `{email, status}` (status pending) enforces it, plus `{user, createdAt}`.
   - A second form submission merges into the pending row, and the latest submission wins whole.
   - The form never merges into a WhatsApp row, or into an account-linked row unless the submitter is signed in as that customer. Those cases drop silently.
   - Accepted risk: an anonymous submission can overwrite an unlinked form row for an email it knows. Nothing about the account or its credentials changes.
5. **Identical answer.** The public answer is `{ok:true}` for every case: new, merged, existing customer, limited, honeypot, too fast and not-ours. Only field errors and our own outage (`unavailable`) differ.
6. **Emails.**
   - The company alert goes out only for a new row, after the response (`after()`), and carries name, company, country and kind. The settings address wins over `COMPANY_EMAIL` (`getCompanyAlertEmail`).
   - No acknowledgement email goes to the requester.
   - The decline email is optional and never includes the reason.
7. **Approval.** The approval is an atomic claim from pending. The claim is released only if something fails before the account write. After the account is written, nothing rolls back: a failed later step returns a partial-success message, and `issueInvite` returns `{state:"failed"}` instead of throwing.
   - On an existing account, approval extends access. It sends an invite when the last one expired, or when there never was one and no password was ever set (`needsInvite`).
   - It never creates a second account.
8. **Retention.** The admin deletes handled requests by hand (Q12). There is no automatic purge; the question goes to the Phase 7 privacy page.
9. **Audit:** `access_request.approve | reject | create_manual | delete`. Meta holds ids and counts only.

## Consequences
- Service API: `submitAccessRequest` (public, for P6); `listAccessRequests`, `getAccessRequest`, `approveAccessRequest`, `rejectAccessRequest`, `createManualAccessRequest` and `deleteAccessRequest` (admin, for P7). Each admin write takes `{id, headers}` from a `requireAdmin()` action.
- `npm run db:indexes` must run on every database. It fails if two pending requests for the same email already exist, so clean those up first.
- Launch list: a Vercel Firewall rate limit on `POST /request-access`.
