# 0026 — Proxy returns the CN 403 itself; malformed switch fails closed
- Status: Accepted
- Date: 2026-10-03
- Refines: ADR 0003 ("rewrite to `/blocked` with HTTP 403") and ADR 0007 (open 403 question). Implements Phase 1 task 8.

## Context
- ADR 0003 planned `NextResponse.rewrite('/blocked', { status: 403 })`. ADR 0007 left open whether a rewrite keeps the status.
- In Next.js 16.3.7, `server/lib/router-utils/resolve-routes.js` (around line 466) handles a middleware rewrite by changing the URL only, and the status is not carried along. Vercel's router is a separate implementation, so it can't be relied on there either.
- The user decided on 2026-10-01 that a malformed `GEO_BLOCK_ENABLED` fails closed.

## Decision
- **Direct 403.** `src/proxy.ts` answers a blocked request itself with `blockedResponse()` from `src/lib/geo.ts`:
  - status 403;
  - a complete inline-styled HTML page with no scripts, links, images or fonts, because every other request from that visitor is blocked too;
  - `Cache-Control: private, no-store`, `Vary: x-vercel-ip-country`, `X-Robots-Tag: noindex`.
- **Verified with `next start` + curl:**
  - CN / cn → 403 on pages and `/api/*`;
  - HK, MO, TW, US and no header → 200;
  - `/admin` with no session cookie → 307 to `/login`.
- **Country rule:**
  - an exact match on `x-vercel-ip-country` being `CN`, after trimming and upper-casing;
  - anything else, including a missing header (local dev), passes;
  - the switch is read only for CN requests.
- **Switch:**
  - `GEO_BLOCK_ENABLED` accepts `true`/`1`/`false`/`0`; unset means off.
  - A malformed value keeps the block **on** for CN.
  - The `EnvError` message, which names the variable but not its value, is logged once per instance.
  - Any other error is rethrown.
- **Matcher:** `/((?!_next/static/|favicon\.ico$).*)`, so everything except `/_next/static/…` (hashed build files) and exactly `/favicon.ico`. The exclusions are anchored, so look-alikes such as `/_next/staticfoo` are still covered (QA L1). Pages, `/api/*`, Server Action POSTs, `/_next/image`, robots and sitemap are all covered.
- **Order:** geo-block first, then the coarse `/admin` redirect.
  - The redirect covers `/admin` and `/admin/*` pages only, and only when no Better Auth session cookie is present (`yg.session_token` or `__Secure-yg.session_token`, via `better-auth/cookies` `getSessionCookie`).
  - The cookie's validity is never judged here; `requireAdmin()` decides (ADR 0024).
  - Admin APIs live under `/api` and answer 401/403 through `requireAdminForRoute()`.
- **Keeping the proxy light:** the proxy imports only `geo.ts` (env) and `session-cookie.ts`, never Better Auth's server, Mongoose or the database. The `yg` cookie prefix is defined once in `session-cookie.ts` and used by `auth.ts`.

## Consequences
- The `/blocked` page (task 10) is for direct visits and previews only. Blocked visitors get the proxy's own page.
- The Vercel Firewall rule (CN → deny, on the real IP) remains the first layer (ADR 0003) and is a **go-live requirement**, not an option. The proxy is the backup.
- **Hosting dependency.** The proxy layer only means something on Vercel, which sets `x-vercel-ip-country` itself.
  - Elsewhere the header comes from the client, so a CN visitor can bypass the proxy by leaving it out (QA I1).
  - A third-party CDN in front of Vercel would serve cached static 200s to CN without running the proxy (QA I2).
  - Moving off Vercel, or adding a CDN in front, needs a new geo-block decision.
- **Unset or misnamed switch.** A missing or misspelled `GEO_BLOCK_ENABLED` silently means "off", and a malformed one is only logged on the first CN request (QA L2). The Phase 10 go-live checklist therefore includes: "`GEO_BLOCK_ENABLED=true` in Production and the Vercel Firewall CN rule active, both tested with a CN request".
- `/_next/static` (client JS chunks, fonts) is still served to CN visitors. That is acceptable because rule 9 keeps restricted values out of every client bundle.
- The page text lives in `geo.ts`. Change it there.
