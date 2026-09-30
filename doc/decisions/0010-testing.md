# 0010 — Testing: Vitest + Playwright
- Status: Accepted
- Date: 2026-09-30

## Decision
- **Vitest** for pure logic and server code: import parser, permissions, rate limiter, crypto, access/expiry rules, Zod schemas. DB tests use `mongodb-memory-server`.
- **Playwright** for end-to-end flows: login, forced password change, gated download, admin guard, restricted-data leak check, geo-block header matrix (CN → 403; HK/MO/TW/none → 200).
- CI (GitHub Actions) runs lint, typecheck, Vitest, build and `npm audit` on every PR and every push to `main`. Playwright runs in CI too, against `next build && next start` (Chromium). Once Vercel exists, it also runs against preview deployments for the geo-header tests.
- Vitest config is `vitest.config.mts`, with `server-only` stubbed so server modules can be tested. `typecheck` is `next typegen && tsc --noEmit`, because the generated route types (`LayoutProps`) must exist first.

## Consequences
- A phase is not done until its tests are green.
