# 0027 — Security headers and a static CSP with inline scripts allowed
- Status: Accepted
- Date: 2026-10-03
- Implements: Phase 1 task 9

## Context
- Every response needs a CSP, HSTS, `nosniff`, a Referrer-Policy and framing protection.
- A strict CSP in Next.js 16.3.7 means either per-request **nonces** or **hashes**:
  - Nonces force every page to render dynamically (installed docs: `02-guides/content-security-policy.md`). That gives up the tagged catalog cache (ADR 0008) and CDN caching.
  - Hashes would have to come from the experimental `experimental.sri` option.
- **Tested in task 9** (`next build` + `next start` + headless Chromium, recording `securitypolicyviolation` events):
  - with `sri` and `script-src 'self'`, Next adds `integrity` only to the external chunk files;
  - the App Router's inline `<script>` tags (streamed page data, `self.__next_f.push`) are blocked;
  - hydration fails (React error 412) on both a normal page and the 404;
  - those inline scripts differ per page, so a fixed hash list can't work either.

## Decision
- **One pure module, `src/lib/security-headers.ts`**, used by `next.config.ts` `headers()` for `/:path*`.
- **CSP:**
  - `default-src 'self'`;
  - `script-src 'self' 'unsafe-inline'`, plus `'unsafe-eval'` only under `next dev`;
  - `style-src 'self' 'unsafe-inline'`, because React writes `style=""` into server HTML and the motion libraries set inline styles;
  - `img-src 'self' data: blob: https://res.cloudinary.com` and `media-src 'self' https://res.cloudinary.com`;
  - `font-src`, `connect-src`, `worker-src` and `manifest-src` are all `'self'`;
  - `frame-src 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`;
  - `upgrade-insecure-requests` outside dev.
- **What this CSP still does without nonces:** it blocks every external script host and every `eval` in production. It also blocks plugins, `<base>` hijacking, cross-site form posts, framing (clickjacking), and data exfiltration through `fetch` or images to foreign hosts.
- **Other headers:**
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains`. No `preload` until the final domain is known.
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`.
  - `Permissions-Policy` turns off camera, microphone, geolocation, payment, USB and browsing-topics.
- **Whistleblower** (`/whistleblower` and `/whistleblower/*`): `Referrer-Policy: no-referrer` (rule 7). It is listed after the global rule, and for the same header key the later rule wins.
- **The proxy's CN 403 page** (`geo.ts`) sends its own stricter set: `default-src 'none'; style-src 'unsafe-inline'; …` plus `nosniff`, `no-referrer` and `DENY`. `next start` showed that when the proxy sets a header itself, its value replaces the config value, while config-only headers such as HSTS are still added.
- **`experimental.sri` is not enabled.** It doesn't make the CSP strict, and it is experimental.
- **Verified:** production pages and the 404 hydrate with zero violations; `next dev` (eval + HMR) has zero violations; the CN 403 page renders its inline style with zero violations.

## Consequences
- With `'unsafe-inline'`, the CSP is **not** an XSS backstop for injected inline scripts. XSS prevention rests on:
  - React's escaping;
  - never rendering untrusted HTML: `dangerouslySetInnerHTML` only for JSON-LD, built with `JSON.stringify` and with `<` escaped as `<`;
  - Zod validation of all input (rule 8).
- **Hosts to add later**, each with a note here:
  - Phase 2 admin uploads (Cloudinary upload API and R2 presigned PUT) will need `connect-src` hosts;
  - any map or video embed will need `frame-src`;
  - analytics are not planned, and must never load on whistleblower pages.
- **Revisit nonces** if the site ever renders all pages dynamically anyway, or if Next ships hash support for inline scripts.
- **Before Phase 10:** confirm `upgrade-insecure-requests` and HSTS on the client's domain, and decide on `preload`.
