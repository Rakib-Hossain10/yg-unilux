# 0009 — Cloudflare R2 for private files
- Status: Accepted
- Date: 2026-09-30

## Context
Datasheets and whistleblower attachments must never be behind a public URL. Options were Cloudinary `authenticated` raw files or a private R2 bucket.

## Decision
- Private R2 bucket, accessed with the S3 SDK (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
- Downloads use presigned GET URLs valid ~60 s, issued only after the access check.
- Uploads go through the server (signature and size checks first); bucket has no public access and no public domain.
- Cloudinary stays for public images only.
- All access goes through `lib/storage.ts` so the provider can be swapped.

## Consequences
- Env: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
- Clean separation: nothing private ever lives in Cloudinary.
