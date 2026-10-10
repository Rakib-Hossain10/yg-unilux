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
