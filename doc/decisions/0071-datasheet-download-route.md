# 0071 — Datasheet download route
- Status: Accepted
- Date: 2026-10-10

## Context
Rule 2 and plan Q9: datasheets leave the private R2 bucket only through `GET /api/datasheet/[productId]`, linked by a plain `<a>` from the product page and `/my-downloads`. Each viewer state needs its own answer. The route must not be usable to scrape every file, and the download history must be complete.

## Decision
1. **Order of checks.** Each step answers before the next one runs.
   - Zod ObjectId on `productId`. A bad id → 404.
   - The published product and the database session are read in parallel. A failure → 503, never "signed out".
   - Draft, unknown, or no `datasheetId` → 404 for everyone, the admin too. Whether a published product has a datasheet is public; a draft never redirects anyone.
   - `checkDatasheetAccess` (the shared rule):
     - signed out, temporary password or another role → 303 `/login?next=/product/<slug>`;
     - expired or banned → 303 `/request-access?renew=1&product=<id>`.
   - Datasheet row missing → 404. Only a viewer who may download can learn that.
   - Per-user limit → 429.
   - Presign, then the log → 303 to the presigned URL.
2. **Every answer** is `Cache-Control: private, no-store`. Redirects are 303 with an empty body. 404, 429 and 503 are short `text/plain` pages with `nosniff`; 429 and 503 carry `Retry-After`.
3. **Presigned GET** (`storage.presignGet`):
   - valid 60 s;
   - signs `ResponseContentType` (xlsx) and `ResponseContentDisposition: attachment` with an ASCII `filename=` fallback and an RFC 5987 `filename*=UTF-8''…`. Control characters are dropped, path separators become `_`, and the header is printable ASCII only;
   - signs only `datasheets/<uuid v4>.xlsx` keys; anything else throws.
4. **Log before the redirect.** The `downloadLogs` entry (user, product, datasheet) is written before the URL is returned. If the write fails, the download is refused with 503 and no URL (fail closed). Logs never hold the URL or the R2 key; errors log the error type only.
5. **Per-user limit:** 60 per hour, namespace `download-user`, keyed by the HMAC of the user id. The admin is exempt. It is counted only once the datasheet row exists. A later 503 (R2 or the log write down) still uses a slot; accepted. If the limiter is unavailable → 503.
6. **Static guard** (`test/datasheet-download-guards.test.ts`): only the route names `presignGet`. No module takes `storage.ts` whole (`import *`, `export *`, `import()`, `require()`), with a self-test for each form. `test/admin-uploads.qa.test.ts` allows `src/lib/datasheet-download.ts` and the route to name `storageKey`.
7. **e2e:** the R2 fake answers presigned GETs. Past the window it answers 403; otherwise it returns the signed type and file-name headers.

## Consequences
- A ban made through Better Auth ends the session, so a banned customer normally gets the login redirect. The renewal answer covers a session that is still alive.
- `/request-access` (P6) receives `renew=1&product=<id>`.
- Launch list: a Vercel Firewall rate limit on `/api/datasheet/*`.
- Playwright can't intercept a navigation's redirect, so the e2e test follows the 303 by hand. A real browser download test (P9) needs a context-level route or a proxy for the R2 host.
- Gate A: confirm the QA-test allowlist change; check real R2 honours `response-content-disposition` with `filename*` once credentials exist; optionally refuse `Sec-Purpose: prefetch` requests.
