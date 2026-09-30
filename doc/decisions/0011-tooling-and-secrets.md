# 0011 — Tooling, dependencies and secrets
- Status: Accepted
- Date: 2026-09-30

## Decision
- Package manager: **npm**.
- Runtime deps: `mongoose`, `next-auth` (Auth.js v5), `bcryptjs` or `@node-rs/argon2`, `zod`, `react-hook-form`, `@hookform/resolvers`, `cloudinary`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `resend`, `exceljs`, `jszip`, `sharp`, `server-only`, `gsap`, `lenis`, `motion`.
- Dev deps: `vitest`, `@vitest/coverage-v8`, `mongodb-memory-server`, `@playwright/test`, `prettier`, `prettier-plugin-tailwindcss`, `tsx`.
- Secrets live in `.env.local` (gitignored), are server-only (`import "server-only"`, Zod-validated in `src/lib/env.ts`) and are **never** prefixed `NEXT_PUBLIC_`.
- `.env.example` lists every variable with an empty value: `MONGODB_URI, AUTH_SECRET, AUTH_URL, CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, RESEND_API_KEY, EMAIL_FROM, COMPANY_EMAIL, GEO_BLOCK_ENABLED, WHISTLEBLOWER_ENC_KEY, CRON_SECRET, SITE_URL`.

## Resolved in Phase 0
- **Versions:** next 16.3.7, react 19.2.8, typescript 5.9.3, tailwindcss 4.3.3, mongoose 9.10.3, zod 4.6.5, Node ≥ 22 (`.nvmrc` = 22).
- **Password hasher:** `@node-rs/argon2` (argon2id). Next already treats it as a server-external package, and it was proven under `next build` + `next start`.
- **Auth library:** not installed. Upstream Auth.js now gets only security patches and recommends Better Auth for new projects. The choice is pending, and Phase 1 auth is blocked on it.
- **Install scripts are denied by default.** `package.json` `allowScripts` denies esbuild, mongodb-memory-server and unrs-resolver (all optional), and CI runs `npm ci --ignore-scripts`. A new install script needs explicit approval.
- **`agentRules: false`** in `next.config.ts`, so `next dev` never rewrites the hand-kept CLAUDE.md.
- **npm 12 is expected.** `package.json` `devEngines.packageManager` is npm ^12.1.0 with `onFail: "warn"`. Older npm prints an `EBADDEVENGINES` warning and carries on; contributors should run `npm install -g npm@12` because the `allowScripts` deny policy only works on npm 12.
  - It is `"warn"`, not `"error"`: the QA re-review showed that `"error"` makes npm 10/11 fail on every command, which would break Vercel's build (Node 22's npm 10) and Dependabot's npm updater.
  - CI installs npm 12.1.0 first (`NPM_VERSION` in `ci.yml`).
  - Dependabot does not bump `NPM_VERSION`; keep it in step with `devEngines` by hand.
- **uuid advisory fixed:** GHSA-w5hq-g745-h8pq came in through exceljs 4.4.0 (uuid 8.3.2) and is fixed with `"overrides": { "uuid": "^11.1.1" }`. An exceljs round-trip test covers the one code path that uses uuid. `npm audit` shows 0 vulnerabilities. exceljs itself has had no release since 2023; re-evaluate it before Phase 3 (import), where it will parse untrusted uploads.
- **ESLint enforces the secrets rule:** `process.env` may be read only in `src/lib/env.ts`, `**/*.config.*` and `scripts/**`, and any `NEXT_PUBLIC_` name or string is an error.
- **Whitespace in env values:** a whitespace-only value is an error, even for optional variables, and secrets padded with whitespace are invalid.
- **env API:** `src/lib/env.ts` validates each feature lazily (`env.mongo()`, `env.r2()`, `env.whistleblowerKey()`, …). A missing or invalid variable throws `EnvError`, which names the variable but never its value, so the app builds with no secrets set.

## Consequences
- Adding a variable means updating `env.ts`, `.env.example` and Vercel project settings together.
