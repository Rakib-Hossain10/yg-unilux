// Mainland-China geo-block rules for src/proxy.ts (CLAUDE.md security rule 6,
// ADR 0003, 0026): block only country "CN", never HK, MO or TW, switched by
// GEO_BLOCK_ENABLED alone. Pure functions plus the self-contained 403 page.

import "server-only";

import { EnvError, env } from "./env";
import { BLOCKED_PAGE_HEADERS } from "./security-headers";

/** The header Vercel sets with the visitor's ISO 3166-1 alpha-2 country. */
export const COUNTRY_HEADER = "x-vercel-ip-country";

/*
 * The only blocked country. Hong Kong (HK), Macau (MO) and Taiwan (TW) have
 * their own codes and must never be blocked, so this is an exact match on
 * one code, never a list or a prefix.
 */
const BLOCKED_COUNTRY = "CN";

/** True when the country header says mainland China. Missing header = not blocked (local dev). */
export function isBlockedCountry(headers: Pick<Headers, "get">): boolean {
  const country = headers.get(COUNTRY_HEADER);
  return country?.trim().toUpperCase() === BLOCKED_COUNTRY;
}

/* Logged once per server instance, so a bad value doesn't flood the logs. */
let reportedBadFlag = false;

/**
 * Whether the block is switched on. A malformed GEO_BLOCK_ENABLED fails
 * closed: the block stays ON and the problem is logged (user decision
 * 2026-10-01, ADR 0026). Only EnvError is caught; its message names the
 * variable, never its value.
 */
export function geoBlockOn(
  readFlag: () => boolean = env.geoBlockEnabled,
): boolean {
  try {
    return readFlag();
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    if (!reportedBadFlag) {
      reportedBadFlag = true;
      console.error(`[geo] ${error.message} Blocking CN until it is fixed.`);
    }
    return true;
  }
}

/** Test hook: lets each test see the first-time log again. */
export function resetGeoLogForTests(): void {
  reportedBadFlag = false;
}

/** True when this request must get the blocked page. */
export function shouldGeoBlock(
  headers: Pick<Headers, "get">,
  readFlag?: () => boolean,
): boolean {
  // Country first: a request from anywhere else never even reads the flag.
  return isBlockedCountry(headers) && geoBlockOn(readFlag);
}

/*
 * The blocked page, sent straight from the proxy with status 403. It is a
 * complete document with inline styles and no scripts, images, fonts or
 * links to other site files, because every other request from the visitor
 * is blocked too. English only, like the site.
 */
const BLOCKED_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not available in your region | YG UniLUX</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;padding:16px;
    background:#fff;color:#111;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:32rem;text-align:center}
  h1{font-size:1.5rem;font-weight:600;letter-spacing:.02em;margin:0 0 .75rem}
  p{margin:0;color:#555}
  @media (prefers-color-scheme:dark){body{background:#111;color:#f5f5f5}p{color:#aaa}}
</style>
</head>
<body>
<main>
<h1>YG UniLUX</h1>
<p>Sorry, this website is not available in your region.</p>
</main>
</body>
</html>
`;

/**
 * The 403 response for a blocked visitor. Never cached by a shared cache
 * (the same URL is a normal page for everyone else), and Vary on the
 * country header for any cache that ignores `private`.
 */
export function blockedResponse(): Response {
  return new Response(BLOCKED_HTML, {
    status: 403,
    headers: {
      // The proxy's own value wins over next.config headers() for the same
      // name, so the page brings its own strict CSP etc. (ADR 0027). Spread
      // first, so the cache rules below can never be overridden by it.
      ...Object.fromEntries(
        BLOCKED_PAGE_HEADERS.map(({ key, value }) => [key, value]),
      ),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: COUNTRY_HEADER,
      "X-Robots-Tag": "noindex",
    },
  });
}
