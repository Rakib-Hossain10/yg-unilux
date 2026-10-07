# 0047 — Datasheet storage and service
- Status: Accepted
- Date: 2026-10-06
- Completes: [0045](0045-direct-uploads.md) point 6 (R2 direct uploads); builds on [0001](0001-datasheets-collection.md), [0009](0009-r2-private-storage.md), [0035](0035-admin-write-path.md)

## Context
Datasheets (.xlsx, up to 10 MB) are restricted files. Vercel limits request bodies to about 4.5 MB, so the browser uploads straight to R2 (ADR 0045) and the server verifies afterwards.

## Decision
1. **`src/lib/storage.ts` is the only R2 module.** It uses the S3 client with `forcePathStyle: true` and `region: "auto"`, and credentials only from `env.r2()`. It offers `presignPut`, `headObject`, `getRange`, `getObjectBytes`, `copyObject`, `deleteObject` and `listObjects`. It builds no public URL. A presigned GET for downloads arrives with Phase 5.
   - Checksum calculation is `WHEN_REQUIRED`, because R2 does not take the SDK's default CRC32 trailer on a browser PUT.
   - The presigned PUT expires after 300 s and signs `content-type` and `content-length`, so the browser can only send a file of the declared size to that one key.
2. **Three steps.**
   - `presignDatasheetUpload` validates `{fileName, size}` and returns a PUT to `incoming/<uuid v4>.xlsx`.
   - The browser PUTs the file.
   - `finalizeDatasheet` takes `{mode: "new"|"replace", incomingKey, fileName, datasheetId?}`. The key must match `incoming/<uuid>.xlsx`, so a browser can never name a `datasheets/` object.
3. **Content check (`src/lib/xlsx-signature.ts`).** The extension and the declared size prove nothing, so finalize reads at most 10 MB and checks, in order:
   - not empty, at most 10 MB, and zip magic `PK\x03\x04` at offset 0;
   - the zip central directory (parsed by us, nothing inflated), with the entry count capped at 2000 before any entry is read;
   - `[Content_Types].xml` and `xl/workbook.xml` both present;
   - `[Content_Types].xml` declares the workbook type `...spreadsheetml.sheet.main+xml` (so `.xlsm` is refused). Only this one part is inflated, with `zlib.inflateRawSync` and `maxOutputLength` of 1 MB, so a crafted deflate stream cannot fill memory.
   - Rejections are `empty`, `too_large`, `not_zip`, `corrupt`, `too_many_entries` and `not_xlsx`, each with an admin message.
4. **`incoming/` is always cleaned up.** After the key is valid, everything runs in `try ... finally` that deletes the incoming object (best effort, logged by error class only). A request with an invalid body but a well-formed incoming key also deletes that object. A key outside `incoming/` is never deleted.
5. **Replace keeps the `storageKey`.** The new bytes are copied over the existing key, then `fileName`, `size` and `uploadedBy` are updated. A failed check leaves the stored file untouched, because the copy happens only after verification. If the document vanished meanwhile, the recreated object is deleted. A new datasheet whose document write fails has its fresh `datasheets/` copy deleted, so no orphan remains. If the copy succeeds but a replace's document update throws, the file is already overwritten and cannot be rolled back (see consequences).
6. **Delete.** It is refused while any product has the `datasheetId`, and the message says how many. The R2 object is deleted BEFORE the document. If R2 fails the document stays and the delete can be retried. The reverse order would leave an unreachable private file. The few-millisecond gap between the in-use check and the delete is accepted, because `updateProduct` only attaches a datasheet that exists.
7. **Rename and list.** `renameDatasheet` changes only the label, with a new audit action `datasheet.rename`. `listDatasheets` returns the rows with an in-use count (one grouped query over the `datasheetId` index) and never the storage key.
8. **Audit and tags.** Actions are `datasheet.upload`, `datasheet.replace`, `datasheet.rename` and `datasheet.delete`. `meta` holds `{size}` only, never the file name. Every write returns the tag `datasheets`. Presign writes nothing and returns no tags.
9. **Publish re-checks references (gate B I-2).** `publishProduct` now also checks that the stored `mainCategory` and `datasheetId` still exist, and refuses with field errors on `mainCategory` / `datasheetId` otherwise. `PublishProblem.field` gains `"datasheetId"`.

## Consequences
- The bucket needs the CORS rule from the Phase 2 plan, and an optional lifecycle rule for `incoming/`. T17 sweeps `incoming/` older than 24 h and reports orphaned `datasheets/` objects.
- Replacing a file overwrites in place. A download at that moment may see either version; acceptable until Phase 5.
- A failed document write during a replace (after the copy) leaves the new bytes under the old row. The admin sees an error and can re-upload.
- ADR 0009's "uploads go through the server" is superseded by 0045 and this ADR.
