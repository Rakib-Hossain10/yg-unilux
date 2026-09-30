# 0011 — Tooling, dependencies and secrets
- Status: Accepted
- Date: 2026-09-30

## Decision
- Package manager: **npm**.
- Runtime deps: `mongoose`, `next-auth` (Auth.js v5), `bcryptjs` or `@node-rs/argon2`, `zod`, `react-hook-form`, `@hookform/resolvers`, `cloudinary`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `resend`, `exceljs`, `jszip`, `sharp`, `server-only`, `gsap`, `lenis`, `motion`.
- Dev deps: `vitest`, `@vitest/coverage-v8`, `mongodb-memory-server`, `@playwright/test`, `prettier`, `prettier-plugin-tailwindcss`, `tsx`.
- Secrets live in `.env.local` (gitignored), are server-only (`import "server-only"`, Zod-validated in `src/lib/env.ts`) and are **never** prefixed `NEXT_PUBLIC_`.
- `.env.example` lists every variable with an empty value: `MONGODB_URI, AUTH_SECRET, AUTH_URL, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, RESEND_API_KEY, EMAIL_FROM, COMPANY_EMAIL, GEO_BLOCK_ENABLED, WHISTLEBLOWER_ENC_KEY, CRON_SECRET, SITE_URL`.

## Consequences
- Adding a variable means updating `env.ts`, `.env.example` and Vercel project settings together.
