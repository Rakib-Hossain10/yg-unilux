# 0010 — Testing: Vitest + Playwright
- Status: Accepted
- Date: 2026-09-30

## Decision
- **Vitest** for pure logic and server code: import parser, permissions, rate limiter, crypto, access/expiry rules, Zod schemas. DB tests use `mongodb-memory-server`.
- **Playwright** for end-to-end flows: login, forced password change, gated download, admin guard, restricted-data leak check, geo-block header matrix (CN → 403; HK/MO/TW/none → 200).
- CI (GitHub Actions) runs lint, typecheck, Vitest and build on every PR; Playwright runs against preview deployments.

## Consequences
- A phase is not done until its tests are green.
