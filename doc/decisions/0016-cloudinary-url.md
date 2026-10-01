# 0016 — Single CLOUDINARY_URL and a per-account next/image allow-list
- Status: Accepted
- Date: 2026-10-01

## Context
The Cloudinary console gives one credential string, `CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>`, and that is what the user has. ADR 0011 had three separate variables (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`). The user also added `res.cloudinary.com` to `next/image` `remotePatterns` with no path restriction.

## Decision
- **One variable: `CLOUDINARY_URL`.** It replaces the three variables everywhere: `env.ts`, `.env.example`, the tests and the Vercel settings.
- **`src/lib/cloudinary-url.ts`** is a pure parser with no `server-only` import, so `env.ts` and `next.config.ts` share it.
  - It accepts only `cloudinary://<numeric key>:<[A-Za-z0-9_-] secret>@<cloud name>`, with an optional trailing slash.
  - A port, path, query (private-CDN options), fragment, the pasted `CLOUDINARY_URL=` prefix, or bad percent-encoding are all rejected.
  - It never throws, and the value never appears in any error.
- **`env.cloudinary()`** still returns `{ cloudName, apiKey, apiSecret }`, so callers are unchanged. An invalid value gives `EnvError` with the expected format.
- **`next.config.ts`** allows `next/image` remote images only from `https://res.cloudinary.com/<cloud_name>/**`. This is what the installed Next.js docs recommend: "only external images from your account".
  - Without it, `/_next/image` could be used to resize images from any Cloudinary account at our cost.
  - If `CLOUDINARY_URL` is not set (CI, a fresh checkout), the allow-list is empty and the build still works.
  - If it is set but malformed, the build fails with the expected format and no value.
- **`images.formats`** is `["image/avif", "image/webp"]`.
- **Phase 2 (`src/lib/cloudinary.ts`):** configure the SDK explicitly from `env.cloudinary()` (`cloudinary.config({ cloud_name, api_key, api_secret, secure: true })`). The `cloudinary` package also reads `CLOUDINARY_URL` from the environment on its own; don't rely on that implicit path, so validation and error messages stay in one place.

## Consequences
- Changing the Cloudinary account (for example, moving to the client's account at handover) means changing one variable. The image allow-list follows automatically on the next build.
- The cloud name is fixed at build time, so redeploy after changing `CLOUDINARY_URL`.
