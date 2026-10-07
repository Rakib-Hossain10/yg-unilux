// Security headers for every response (Phase 1 task 9, ADR 0027): CSP, HSTS,
// nosniff, Referrer-Policy, framing and permissions. Pure functions, because
// next.config.ts imports this file at build time (no server-only, no env.ts).

/** One response header, in the shape next.config.ts `headers()` expects. */
export interface Header {
  key: string;
  value: string;
}

export interface CspOptions {
  /** `next dev`: React needs eval for its error overlay and stack traces. */
  isDev: boolean;
  /** When true, inline scripts are allowed (see ADR 0027 for why). */
  allowInlineScripts: boolean;
  /**
   * Extra `connect-src` origins, added after 'self'. Only the admin panel
   * uses this (direct uploads, see adminConnectSrc); public pages pass none.
   */
  extraConnectSrc?: readonly string[];
}

/*
 * Sources outside our origin that pages may load:
 * - Cloudinary delivers product images and video (ADR 0016). next/image
 *   goes through /_next/image (same origin), but videos and admin previews
 *   load from res.cloudinary.com directly.
 * Add a host here only together with an ADR note: every entry widens what an
 * injected tag could load.
 */
const CLOUDINARY_DELIVERY = "https://res.cloudinary.com";

/**
 * The Content-Security-Policy value. Every fetch type falls back to 'self';
 * plugins, <base> tricks, cross-site form posts and framing are refused.
 */
export function buildCsp({
  isDev,
  allowInlineScripts,
  extraConnectSrc = [],
}: CspOptions): string {
  const scriptSrc = [
    "'self'",
    allowInlineScripts ? "'unsafe-inline'" : null,
    isDev ? "'unsafe-eval'" : null,
  ].filter((source): source is string => source !== null);

  const directives: [string, ...string[]][] = [
    ["default-src", "'self'"],
    ["script-src", ...scriptSrc],
    // React renders style="" attributes into server HTML and the motion
    // libraries set inline styles, so inline styles stay allowed. Styles
    // can't run code; the script rules above are what stop XSS.
    ["style-src", "'self'", "'unsafe-inline'"],
    ["img-src", "'self'", "data:", "blob:", CLOUDINARY_DELIVERY],
    ["media-src", "'self'", CLOUDINARY_DELIVERY],
    ["font-src", "'self'"],
    ["connect-src", "'self'", ...extraConnectSrc],
    ["frame-src", "'none'"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'self'"],
    ["form-action", "'self'"],
    ["frame-ancestors", "'none'"],
  ];
  // Not in dev: `next dev` runs on plain http://localhost.
  if (!isDev) directives.push(["upgrade-insecure-requests"]);

  return directives.map((parts) => parts.join(" ")).join("; ");
}

/*
 * Upload endpoints the admin panel's browser code posts files to directly
 * (ADR "Direct uploads, server verifies"): Cloudinary's Upload API for
 * images, and the R2 S3 endpoint for presigned datasheet PUTs (T12). The R2
 * host is `<account id>.r2.cloudflarestorage.com`, so presigned URLs must use
 * path-style addressing (bucket in the path, not the host name).
 */
const CLOUDINARY_UPLOAD_API = "https://api.cloudinary.com";
/** Cloudflare account ids are 32 lowercase hex characters. */
const R2_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The `connect-src` additions for /admin pages only. Without an R2 account id
 * (CI, a fresh checkout) only Cloudinary is added. A set but malformed id
 * throws, so a typo fails the build instead of emitting a broken host; the
 * value is never put in the error.
 */
export function adminConnectSrc(r2AccountId: string | undefined): string[] {
  if (r2AccountId === undefined || r2AccountId === "") {
    return [CLOUDINARY_UPLOAD_API];
  }
  if (!R2_ACCOUNT_ID_PATTERN.test(r2AccountId)) {
    throw new Error(
      "R2_ACCOUNT_ID is invalid. Expected the 32-character hex Cloudflare account id.",
    );
  }
  return [
    CLOUDINARY_UPLOAD_API,
    `https://${r2AccountId}.r2.cloudflarestorage.com`,
  ];
}

/** Headers sent with every response from the app (pages, APIs, assets). */
export function securityHeaders(options: CspOptions): Header[] {
  return [
    { key: "Content-Security-Policy", value: buildCsp(options) },
    // Two years, subdomains included. No `preload` until the client's final
    // domain is known: preload is hard to undo (Phase 10).
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Old browsers that ignore CSP frame-ancestors.
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
  ];
}

/*
 * Whistleblower pages (rule 7): no Referer at all, so neither the page a
 * reporter came from nor the case pages they open are told to anyone.
 */
export const WHISTLEBLOWER_HEADERS: Header[] = [
  { key: "Referrer-Policy", value: "no-referrer" },
];

/**
 * Headers for the proxy's own 403 page (src/lib/geo.ts blockedResponse).
 * For a header name the proxy sets itself, its value replaces the
 * next.config one (checked with next start), so the 403 page gets this
 * stricter CSP. The page has one inline <style> and nothing else to load.
 */
export const BLOCKED_PAGE_HEADERS: Header[] = [
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
];
