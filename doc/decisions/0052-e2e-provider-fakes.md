# 0052 — E2E provider fakes, shared sign-in, one worker

Status: Accepted (Phase 2, T18)

## Decision
- R2 and Cloudinary are faked in e2e by an in-memory HTTP server on 127.0.0.1 (`e2e/fake-providers/server.ts`). A preload (`e2e/fake-providers/preload.mjs`) added only to the `next start` child's `NODE_OPTIONS`, and only when `E2E_FAKE_PROVIDERS_PORT` is set, reroutes HTTPS calls to `*.r2.cloudflarestorage.com` and `api.cloudinary.com` to it. The real `storage.ts` and `cloudinary.ts` run unchanged; no fake code lives in `src/`.
- Browser calls to R2/Cloudinary are stubbed with `page.route` and forwarded to the same store (`e2e/fixtures/providers.ts`).
- Fake credentials are set in `e2e/test-server.ts` and the config's `webServer.env`, and must also be present at build time (the admin CSP `connect-src` is computed at build). They are not in `.env.example`.
- M-1 closed: `e2e/global-setup.ts` signs the admin and customer in once; specs reuse the cookies (`auth-access*` still tests the real form).
- `workers: 1`, `fullyParallel: false`: specs share one database. Project `admin-exit` runs last.
- Three gate C tests assumed unconfigured providers and were adapted (failure injection instead).

## Consequences
- Fakes do not replace a smoke against real R2/Cloudinary credentials.
- `src/app/admin/not-found.tsx` is only reached by pages calling `notFound()` without their own boundary; unknown admin URLs get the root 404.
- Re-running against an already-running test server can exhaust the per-email limiter in `auth-access*`; a normal `npx playwright test` starts a fresh server.
- One unreproduced flake (images alt-text save concatenating old text); watch for a repeat.
