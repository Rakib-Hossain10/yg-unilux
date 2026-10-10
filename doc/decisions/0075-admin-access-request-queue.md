# 0075 — Admin access-request queue: raw form values, copy-once link in dialog state, UTC dates
- Status: Accepted (item 6 waits for the user to confirm)
- Date: 2026-10-10
- Builds on: 0069, 0070, 0073 (Phase 5 P7)

## Context
P7 puts the admin UI on the P3 access-request service: `/admin/access-requests` (pending/handled tabs, detail page, approve/reject/manual entry/delete). Gate A (ADR 0073) requires every service call to carry the actor from the DB session. The invite link and any temporary password must be shown once and never survive a reload.

## Decision
1. **Defaults.** Approve defaults to 12 months, and invite delivery defaults to email for every source. For `source: "form"` requests, choosing "Show once to copy" first shows a warning that the contact details are unverified (gate A L-3). The same warning guards "New invite link" in copy mode.
2. **Dialogs send raw form values.** The client resolver uses the shared Zod schemas for messages, but the actions receive `form.getValues()` and the services parse them. Parsed output is not idempotent (`""` → `null` fails a second parse). The code review found this on reject (an empty reason failed) and on approve (an empty company or country failed). Both are fixed and tested.
3. **Copy-once link lives only in dialog state.** The approve dialog stays mounted across `router.refresh()`, so the link stays on screen while the page changes to "Approved" and is dropped when the dialog closes. It never goes into a URL, log or storage. E2e checks that the token is gone after a reload. The reject audit-failed notice is held by the always-mounted `RequestActions`.
4. **Read helpers.** `src/app/admin/admin-reads.ts` has `pageActor(viewer)` and `readAsAdmin(() => read)`, which turns `AdminActorError` into `forbidden()`. They are the read-side counterpart of `refuseUnlessAdmin`, and P8 reuses them. Write actions map `denied` to `forbidden()`.
5. **Routes.**
   - The list lives in the `(list)` route group, so its `loading.tsx` does not wrap `[id]`.
   - `[id]` has `not-found.tsx` and no `loading.tsx`, so an unknown or malformed id gets a real 404.
   - "Open customer" is left out until P8 adds `/admin/customers/[id]`.
   - "New invite link" (shown after `send_failed`, `limited`, `busy` or `failed`) calls `regenerateInvite` through the access-requests actions.
6. **Dates are shown in UTC with "UTC" written out.** This is a deviation from Q5, which asked for the admin's local time with "UTC" noted. Expiry is stored as 23:59:59.999 UTC on the chosen day. In local time east of UTC (the client is in Asia), that shows as the next morning, which reads like the wrong day. **The user should confirm this or ask for local time.**
7. **New Server Action file.** `src/app/admin/access-requests/actions.ts` is added to the known-files list in `test/admin-write-path.qa.test.ts` (QA-owned). The main session made that one-line change, and gate B should confirm it.
8. **shadcn supply-chain trap.** `npx shadcn add radio-group` wrote `import { cn } from "cn"` and installed the unrelated npm package `cn@0.4.0`. The package was removed, `package.json` and the lockfile were restored, and the import now uses `@/lib/utils`. After any `shadcn add`, check the imports and `package.json` diff.

## Consequences
- P8 reuses `admin-reads.ts` and adds the "Open customer" link from the request detail page.
- Backend follow-up: export `MAX_EMAIL_LENGTH`, `MAX_PHONE_LENGTH` and `MAX_REJECT_REASON_LENGTH` from `@/lib/schemas/access-request`, so client inputs get `maxLength` without importing `@/models/*`. Today email (254) and phone (40) are hard-coded and the reason has no `maxLength`. A shared client-safe UTC date formatter would replace three copies.
- The dashboard card still reads "Open" / "Waiting for a decision". This is cosmetic and left as is.
