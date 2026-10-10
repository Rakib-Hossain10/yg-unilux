# 0077 — Admin customers module: shared copy warning, client-side refresh for invite links, empty custom-date default
- Status: Accepted
- Date: 2026-10-10
- Builds on: 0070, 0073, 0075, 0076 (Phase 5 P8)

## Context
P8 puts the admin UI on the P3 customers service: `/admin/customers` list, `/new`, `[id]` cards, and a dashboard "Expiring in 30 days" card. The rules of ADR 0075 (raw form values, copy-once link only in client state, actor check, real 404) apply.

## Decision
1. **Routes.** The list lives in a `(list)` route group (its `loading.tsx` doesn't wrap `[id]`); `[id]` has `not-found.tsx` and no `loading.tsx`. `/new` replaces the form with the outcome instead of redirecting, so a copy-once link stays in component state.
2. **Guards.** Every page and action: `requireAdmin()` → actor `{ id, headers }` → service; `denied` and `AdminActorError` → `forbidden()`. Shared action helpers (`failure`, `inviteView`, `auditMessage`) live in server-only `src/app/admin/action-helpers.ts` for P7 and P8.
3. **Copy warning.** On the customers pages "Show once to copy" always asks first with a general "check who you send this link to" warning (the contact's origin isn't known there). P7 keeps its website-form wording.
4. **Invite refresh is client-driven.** The regenerate action doesn't revalidate: on a filtered list a server refresh would remove the row and its dialog holding the link. The list refreshes when the dialog closes; the customer page refreshes immediately and the panel keeps the link.
5. **"New invite link" offered** when the invite is pending or expired, or there is no invite and the customer is still on a temporary password.
6. **Custom-date default.** With a future current end, the date input pre-fills it (saving unchanged changes nothing). Otherwise it starts empty and must be picked, so saving can't silently end access tonight.
7. **New Server Action file** `src/app/admin/customers/actions.ts` added to the known-files list in QA-owned `test/admin-write-path.qa.test.ts`; gate B confirms.

## Consequences
- An unchanged profile save reads "Profile saved." (the service has no "unchanged" result). Optional backend follow-up: an `unchanged` flag.
- Backend follow-up: export `MAX_EMAIL_LENGTH` and the block-reason maximum from `@/lib/schemas/customer` (email 254 is hard-coded today).
- The temporary password's "gone after reload" is unit-tested only; gate B re-checks it.
- `test/phase2-exit.qa.test.ts` build-output walk got a 60 s timeout (it exceeded 5 s under full-suite load); gate B confirms.
