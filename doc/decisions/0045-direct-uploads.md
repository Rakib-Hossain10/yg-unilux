# 0045 — Direct uploads, server verifies
- Status: Accepted
- Date: 2026-10-06
- Amends: [0009](0009-r2-private-storage.md) (uploads no longer pass through the server)

## Context
Vercel rejects request bodies over about 4.5 MB. Datasheets and images can each be up to 10 MB. Uploads therefore go from the browser straight to the storage provider, and the server must check every file afterwards (user decision, 2026-10-06, Phase 2 plan).

## Decision
1. **The server chooses every id.** The browser never picks a name. Cloudinary image ids have the shape `yg/<folder>/<ownerObjectId>/<uuid v4>`:
   - lowercase only; the folders are `yg/products` and `yg/areas`;
   - built by `buildPublicId` with `crypto.randomUUID()`.

   `src/lib/cloudinary-ids.ts` is client-safe. It holds the shape (`PUBLIC_ID_PATTERN`) and the per-owner check (`isOwnPublicId`).

   Only this shape passes the shared Mongoose `publicIdField` and the Zod `publicIdSchema`/`optionalPublicIdSchema`. That closes gate A L-2 and gate B L-C.
2. **Signing (Cloudinary).** `signCloudinaryUpload(actorId, {target: "product"|"area", id})` checks that the owner exists, then returns `{uploadUrl, cloudName, publicId, fields}`.
   - `fields` are exactly what the browser posts with the file: `api_key`, `timestamp`, `public_id`, `allowed_formats=jpg,png,webp,avif`, `overwrite=false` and `signature`.
   - The signature uses `cloudinary.utils.api_sign_request` (SHA-1 over the sorted params plus the secret) and covers every field except `api_key`.
   - `overwrite=false` stops a replayed signature from replacing an image after it was verified.
   - The API secret never leaves `src/lib/cloudinary.ts`, which configures the SDK explicitly from `env.cloudinary()` (ADR 0016).
3. **Verification.** The signed API can't cap file size, so a save verifies every NEW id:
   - The id must be in the owner's own folder.
   - `api.resource` must then show an image of at most `MAX_IMAGE_BYTES`, in an allowed format.

   On failure:
   - A file that fails these checks is deleted (`uploader.destroy`, `invalidate: true`), and nothing is saved.
   - An id outside the owner's folder is refused but never deleted, because it may be someone else's live image.
   - If Cloudinary can't be reached, nothing is deleted and the admin retries.

   Ids already stored on the product are not checked again.
4. **Saving.** `saveProductImages` takes the full ordered list: `{productId, images: [{publicId, alt, kind}]}`, at most 30 images, alt text required.
   - Add, remove and reorder are one idempotent call, with optimistic concurrency (ADR 0043).
   - It refuses to remove an image that a variant uses, and to leave a published product with no image. The update filter also enforces both atomically.
   - `updateProduct` requires a variant's `imagePublicId` to be one of the product's own images.
   - The audit entry is `product.images.update`, with counts only.
   - Only `setAreaImage` (verified) sets an area's `bwImage`. The area form can only keep or clear it, and create refuses one.
5. **Removed images are not deleted.** These all stay in Cloudinary, and the T17 orphan report lists them:
   - images removed from a product;
   - an area's replaced `bwImage`;
   - the images of a deleted product.

   They are public, a cached page or a stale tab may still show them, and a delete can't be undone.
6. **R2 (planned, T12).** Datasheets use the same pattern:
   - `presignDatasheetUpload` gives a presigned PUT to `incoming/<uuid>.xlsx`, valid for 5 minutes, with `ContentType` and `ContentLength` signed.
   - `finalizeDatasheet` checks the key, size, magic bytes and zip entries, copies the file to `datasheets/`, and always deletes the incoming object.
   - Presigned URLs must use path-style addressing (`forcePathStyle: true`), so the host is `<account>.r2.cloudflarestorage.com`, the one host the admin CSP allows.
   - The bucket needs the CORS rule from the Phase 2 plan.

## Consequences
- The admin browser needs `connect-src` for `https://api.cloudinary.com` and the R2 endpoint, on `/admin` only (see the ADR 0027 note).
- These remain orphans until T17 deals with them:
  - a valid upload that is never saved;
  - every removed image.
- Verification is subject to Cloudinary Admin API rate limits: one `resource` call per new image.
- The Phase 3 import uploads images on the server, under the same id shape, and does not go through `verifyUploadedImage`.
