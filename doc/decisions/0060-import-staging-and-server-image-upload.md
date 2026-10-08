# 0060 — Import staging in R2 and server-side image upload
- Status: Accepted
- Date: 2026-10-07
- Code: Phase 3 T6 (`src/lib/storage.ts`, `src/lib/cloudinary.ts`, `src/lib/schemas/import.ts`, `src/lib/orphan-sweep.ts`, `scripts/sweep-incoming.ts`, `src/lib/audit.ts`, `src/models/audit-actions.ts`)

## Context
The import commit (T7/T8) needs three pieces of infrastructure: a place to stage the uploaded workbook between preview and commit, a capped way to read it back, and a way for the server to put embedded pictures into Cloudinary. ADR 0057 (written in T7) covers the pipeline as a whole; this ADR records the infrastructure choices made in T6.

## Decision
1. **Staging key.** The browser PUTs the workbook straight to R2 at a server-chosen `imports/<uuid v4>.xlsx` (anchored regex `IMPORT_KEY_PATTERN`, dot escaped, lowercase uuid v4 only). The presigned PUT signs the xlsx MIME type and the exact content length (1 byte to `MAX_IMPORT_BYTES` = 30 MB) and lives 5 minutes (`IMPORT_UPLOAD_TTL_SECONDS`). The presign request accepts a browser-reported type of the xlsx MIME, `""` or `application/octet-stream` (browsers vary), but always signs the xlsx MIME.
2. **Capped read.** `getImportBytes(key, {ifMatch?})` checks the key, sends `Range: bytes=0-<cap>` and also counts the stream, destroying it as soon as it passes the cap. It returns the ETag; T8 passes the preview's ETag as `ifMatch` so the commit reads exactly the file the preview read (a still-valid upload link could otherwise replace it). `deleteImportUpload(key)` refuses anything that is not an import key.
3. **Server image upload without `inspectImage`.** `uploadImageBuffer(productId, data)` does a signed `upload_stream` to `yg/products/<productId>/<uuid>`, `overwrite: false`, jpg/png/webp/avif only, and computes `sourceSha256` itself. It runs the same limit checks as `inspectImage` (shared `checkStoredImage`) on the Upload API's own answer instead of an Admin API lookup. The browser flow needs that lookup because the browser could fake its report; here nothing sits between server and Cloudinary, and an Admin API call per image would exhaust the free plan's ~500/hour on a full-catalogue import, breaking normal admin image checks and the Cloudinary sweep for the hour. A rejected image (or a foreign id inside our folder) is destroyed, also when Cloudinary is "unavailable", because an import retry uploads under a new id; an `existing: true` answer is never touched.
4. **Sweep.** `sweep:incoming` also deletes `imports/` objects older than 24 h (`IMPORT_STAGED_MAX_AGE_MS`); one run covers both prefixes under the existing single mass-delete guard (ADR 0053).
5. **Audit.** New action `import.commit`, target type `import`; the target id is the staged file's uuid v4, enforced by a per-target-type id rule in `audit.ts`.
6. **Gate C L-1 closed.** The datasheet key patterns escape the dot; the two `it.fails` tests are plain `it`.

## Consequences
- The real-credential smoke must confirm R2 honours `If-Match` on GET and that a signed server `upload_stream` returns `existing` and the stored facts (format, size, dimensions).
- Low follow-ups left: 24 h / 300 s also appear as literals in `orphan-sweep.ts` / `storage.ts`; the uuid v4 regex is copied in four modules; no test for the non-`Uint8Array` chunk branch.
