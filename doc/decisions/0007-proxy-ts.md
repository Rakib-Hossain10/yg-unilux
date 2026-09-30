# 0007 — `proxy.ts` instead of `middleware.ts`
- Status: Accepted
- Date: 2026-09-30

## Context
Next.js 16 renamed the middleware file to `proxy.ts`.

## Decision
- `src/proxy.ts` handles the CN geo-block and a coarse `/admin` redirect for signed-out users.
- The real authorisation check stays on the server in every admin page, server action and API route (CLAUDE.md rule 3). The proxy is never the only guard.

## Confirmed in Phase 0 (Next.js 16.3.7 docs, `03-api-reference/03-file-conventions/proxy.md`)
- **File:** `src/proxy.ts`. It exports one function, either as the default export or named `proxy`, plus an optional `export const config = { matcher }` (matcher values must be constants).
- **Runtime:** always Node.js. Setting a `runtime` option in the file throws.
- **No matcher** means it runs on every request, including `_next/static`, so always define a matcher.
- **Server Functions** are POSTs to the route that uses them. A matcher that excludes a path also skips those calls, so every Server Function authorises itself.
- **Geo:** `request.geo` was removed. Read the `x-vercel-ip-country` header.
- **403:** it isn't documented whether `NextResponse.rewrite(url, { status: 403 })` keeps the status.
  - Phase 1 must prove it with an e2e test.
  - The fallback is to return a `NextResponse` directly with status 403.

## Consequences
- The coarse `/admin` redirect in the proxy is a convenience only. `requireAdmin()` in each page, route and action is the real guard.
