# 0073 — Admin service actor check, datasheet prefetch/HEAD, safeNextPath dot segments
- Status: Accepted
- Date: 2026-10-10
- Amends: 0068, 0069, 0070, 0071 (Phase 5 QA gate A)

## Context
QA gate A (P1–P5) passed with these findings:
- **M-1:** the P3 services (`src/lib/admin/customers.ts`, `access-requests.ts`) only checked the shape of the actor. A customer passed as the actor could use any write that doesn't hit a Better Auth admin endpoint, for example taking over another customer's invite link or reopening their own expired access. The only guard was the future P7/P8 action's `requireAdmin()`.
- **L-1:** a browser prefetch or a HEAD request to `/api/datasheet/[productId]` (Next runs GET for HEAD automatically) cost a rate-limit slot, a presigned URL and a `downloadLogs` row.
- **L-2:** `safeNextPath` accepted `/..//host`, `/.//host` and `/%2e%2e//host`, which resolve to the path `//host`.
- **I-1:** `approveAccessRequest` sent an invite to an existing blocked customer, while `regenerateInvite` refused.

## Decision
1. **Actor check in every admin service.** Each read and write in `customers.ts` and `access-requests.ts` takes `actor: AdminActor` first. Its first statement comes from `src/lib/admin/actor.ts`:
   - writes: `const refused = await refuseUnlessAdmin(actor, scope); if (refused) return refused;`;
   - reads: `await assertAdminActor(actor)`.

   How the check works:
   - It reads the session from the database through `actor.headers` (`getSessionFromDb`). It requires an active admin who is not banned, a completed password change, and a session user id equal to `actor.id`.
   - A refused write returns `ok:false` with a generic message and `denied: "signed_out" | "not_admin" | "must_change_password" | "actor_mismatch"`. A refused read throws `AdminActorError` with the same reason. P7/P8 map both to `forbidden()`.
   - A database failure during the check returns "try again" and never lets the call through.
   - The check runs before Zod and before any read.
   - It is a second layer behind `requireAdmin()`, never a replacement.
2. **AST guard test.** `src/lib/admin/actor.guard.test.ts` reads the source with the TypeScript compiler API. It enforces where the check sits, that `AdminActor` is the first and only actor parameter, and a pinned list of service names. It also keeps the unguarded building blocks (`issueInvite`, `applyAccess`, `notifyAccessExtended`, `createCustomerAccount`) reachable only from `access-requests.ts`.
3. **Blocked customers.** Approving a request for an existing blocked customer still extends access but makes no invite: the result has `inviteWithheld: true` and the audit meta `invite: "withheld"`. This matches `regenerateInvite`.
4. **Datasheet route.** Speculative requests get 204 (`private, no-store`) right after `connection()`, before any lookup. These are `Sec-Purpose`/`Purpose` containing `prefetch` (including `prefetch;prerender`), `X-Moz: prefetch` and `X-Purpose: preview`. The route exports `HEAD`, which returns 405 with `Allow: GET` and no-store, so the automatic HEAD never runs GET.
5. **`safeNextPath`.** It refuses a `.` or `..` path segment in any decoded layer (the part before `?`/`#`), and, as a last check, a resolved pathname that starts with `//`.

## Consequences
- One extra indexed, uncached session read per admin service call. Acceptable for an admin-only screen.
- P7/P8 must call the services with `{ id: viewer.user.id, headers: await headers() }` and map `denied` / `AdminActorError` to `forbidden()`.
- Products, categories and datasheets services still rely on `requireAdmin()` plus `assertActorId`. Extending the actor check to them is a follow-up to decide before the Phase 5 exit.
- To check by hand at gate C: a Chrome prerender started from the address bar gets the 204. If Chrome then reuses it so the click does nothing, answer `prerender` with 503 + `Retry-After` instead.
- Tests: the 9 QA `it.fails` (gate A) now pass as `it`; `actor.guard.test.ts`; refusal-reason, prefetch/HEAD, dot-segment and I-1 tests.

## Amendment (2026-10-10, Phase 5 P9): speculative requests get 503, not 204
The datasheet route answers speculative requests (`Sec-Purpose: prefetch` / `prefetch;prerender`, `Purpose: prefetch`, `X-Moz: prefetch`, `X-Purpose: preview`, `Next-Router-Prefetch: 1`) with **503, `Retry-After: 0`, `Cache-Control: private, no-store`, empty body**, never a 2xx. P9 proved Chromium keeps a 2xx speculative answer (even an empty 204) and serves the real click from it: `net::ERR_ABORTED`, no file, no log row. A non-2xx is discarded and the click refetches (loopback experiment + real-app e2e in `e2e/restricted-access.spec.ts`). `Retry-After: 0` so Chromium does not pause speculation for the whole site. The check still runs before any lookup, session read, limiter slot, presign or log write. HEAD stays 405. Only Chromium is tested.

## Amendment (2026-10-10, user decision before Phase 5 exit): actor check in every admin service; "End access now"
1. Every exported function in `src/lib/admin/**` and `src/lib/import/index.ts` takes `actor: AdminActor` first and runs `refuseUnlessAdmin` (writes) or `assertAdminActor` (reads) first: products, categories, areas, datasheets, images/uploads, settings, dashboard `getCounts` (gate B I-4), import (new `presignImport`). Exemptions per module, with reasons, in `actor.guard.test.ts` (57 pinned services; default exports/classes refused; runtime check for wrapper-made exports).
2. Pages: `readAsAdmin(() => svc(await pageActor(viewer), ...))`; actions: `denied` → `forbidden()`; admin route handlers: `AdminActorError` → `adminRouteForbidden()` (JSON 403, `private, no-store`).
3. The public column-visibility reader moved to `src/lib/column-visibility.ts` (outside `src/lib/admin`) so cached public code never imports session/auth.
4. Cost: one indexed uncached session read per service call (product edit page: 4). Accepted for admin-only screens.
5. **End access now** (user decision): `endCustomerAccess(actor, {userId})` sets `accessExpiresAt = now`, `expiryReminderFor = null` in one `account-writes` call, audits `customer.access.end` `{hadExpiry}`. Not a ban: sessions, invite, password stay, no email; downloads give the expired redirect. Already ended → `alreadyEnded: true`, nothing written. A separate write, not an `AccessChoice` kind (approve/create share that schema).
6. Leaders, site content and whistleblower services must follow this pattern when built (the guard enforces it under `src/lib/admin`).
7. "End access now" UI: a confirm dialog on the Access card (only while access is running) explains it is not a ban and that extending restores access. An end set by this button is shown as a date and time ("Ended on 10 Oct 2026, 14:30 (China time)"); picked end dates keep "at the end of <day>". Audit label "Access ended"; the label map is typed over the customer/access-request audit actions so a missing label fails `tsc`.
