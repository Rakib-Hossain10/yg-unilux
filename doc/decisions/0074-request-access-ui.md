# 0074 — Request-access UI: one public Server Action, server-only validation, product links
- Status: Accepted
- Date: 2026-10-10
- Builds on: 0064, 0069, 0071 (Phase 5 P6)

## Context
P6 puts a page on the P3 `submitAccessRequest` service: `/request-access` (Q2 fields, `?product=<id>`, `?renew=1`), a WhatsApp button, and links from the product page's datasheet and restricted blocks. The form must work without JavaScript. The QA guard in `test/admin-write-path.qa.test.ts` allowed `"use server"` only in admin `actions.ts` files.

## Decision
1. **One public Server Action.** `src/app/(site)/request-access/actions.ts` is the only allowlisted public action file (`PUBLIC_ACTION_FILES`). The guard also checks that it exports only `async function requestAccessAction(`. The action:
   - reads the FormData into the plain shape;
   - reads the viewer from the database session, skipping the read when there is no session cookie (a failed read means "not linked");
   - calls `submitAccessRequest`.

   The viewer never comes from the form, and form contents are never logged (an error logs only its type). Next's Origin check covers CSRF.
2. **Server-only validation.** The form uses `noValidate`, and the service's Zod is the only source of messages. The action sends the typed values back so fields refill after React's form reset. The country `<select>` is keyed on its value. An untouched required field is posted as `""`, so the schema's own message shows. After an error, the form keeps the first render's `startedAt`, so a quick correction is not dropped as too fast.
3. **Outcome mapping.**
   - Every `{ok:true}` → one identical "sent" state with `ACCESS_REQUEST_THANKS`.
   - `unavailable` or an unexpected throw → `ACCESS_REQUEST_UNAVAILABLE`.
   - Errors only on hidden fields (kind, product) → "This form could not be read. Reload the page and try again."
   - Raw fields over 20,000 characters are refused before the service runs.
4. **Product label.** `getPublishedProductLabel(id)` in `src/lib/catalog/product-ref.ts` is uncached and reads published products only. It returns `{productId, slug, name, modelCode}` and never spec values. Unknown or draft ids are ignored.
5. **Country list.** `countries.ts` has about 195 English short names plus "Other", all accepted unchanged by `countrySchema` (tested). Mainland China is omitted, consistent with the geo-block, while Hong Kong, Macao and Taiwan are listed. A valid stored country that is not in the list is offered as an extra first option. **The client should confirm the omission.**
6. **Page.**
   - Prefill (name, email, company, country) comes from the database session, and the email stays editable.
   - The page is dynamic, so Next sends `private, no-store`, which e2e checks.
   - Metadata is static, with `noindex, follow`.
   - Layout: the intro, then the form, then "What happens next" + WhatsApp. From lg, a 5/7 grid. No motion.
7. **Product-page links.**
   - Pure helpers in `restricted-data.ts`: `signInUrl(slug)` → `/login?next=%2Fproduct%2F<slug>` and `requestAccessUrl(id, {renew})` → `/request-access?[renew=1&]product=<id>`, the same target as the datasheet route's renew redirect.
   - The signed-out state shows "Sign in to download" + "Request access". At lg–xl the visible text shortens to "Sign in", and screen readers still hear "to download".
   - "Access expired — contact us" now links to the renew URL.
   - The slug reaches `DatasheetBlock` as a server-slot prop. `RestrictedDataProvider` props are unchanged, and the restricted copy stays value-free (rule 9).
8. **WhatsApp.** `wa.me/<digits>?text=` with an encoded request/renew sentence, naming the product when known. Nothing renders without a number.

## Consequences
- Gate B confirms the public-action allowlist and tests form abuse on `POST /request-access`. The Vercel Firewall rule for it stays on the launch list.
- Phase 7 links the consent text to the privacy notice (`TODO(Phase 7)`).
- Known trade-off from ADR 0069: a form posted within 3 s of rendering is thanked and dropped, even when it is empty.
- Left open (Low): parity between `requestAccessUrl` and the route's private `renewalPath` is tested only in e2e; `getPublishedProductRef` has no unit test. Stale "arrives in P6" comments and `prefetch={false}` in `reset-expired.tsx` / `my-downloads` can be tidied.
