// Runs before every request (Next.js 16 "proxy", ADR 0007): blocks mainland
// China with a 403 (ADR 0003, 0026), answers a plain 404 for product URLs
// whose slug can never exist, then sends obviously signed-out visitors from
// /admin to /login. It is never the only guard: requireAdmin() is.

import { type NextRequest, NextResponse } from "next/server";

import { blockedResponse, shouldGeoBlock } from "@/lib/geo";
import { hasSessionCookie } from "@/lib/session-cookie";
import { MAX_SLUG_LENGTH, SLUG_PATTERN } from "@/lib/slug";

/** /admin and everything under it (admin pages; admin APIs live under /api). */
function isAdminPage(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

/* /product/<one segment>; a trailing ".rsc" is Next's flight suffix. */
const PRODUCT_PATH = /^\/product\/([^/]+?)(?:\.rsc)?$/;

/**
 * True for /product/<slug> when the slug can never be a product: too long,
 * not decodable, or not lowercase dash-separated words (the same rules
 * getPublicProduct applies, from @/lib/slug). No database call. Other paths,
 * nested ones (/product/a/b) and Next's internal segment-prefetch paths
 * (/product/x.segments/...) are left to Next.
 */
export function isImpossibleProductPath(pathname: string): boolean {
  const match = PRODUCT_PATH.exec(pathname);
  if (!match) return false;
  let slug: string;
  try {
    // The page receives the decoded segment, so test what it would test.
    slug = decodeURIComponent(match[1]!);
  } catch {
    return true;
  }
  return slug.length > MAX_SLUG_LENGTH || !SLUG_PATTERN.test(slug);
}

/*
 * Plain, uncached 404. Next would render the not-found page and store it in
 * the page cache under each new slug (QA gate C L-1), so a flood of random
 * slugs could grow that store; this answer never reaches the page.
 */
function productNotFound(): Response {
  return new Response("Product not found.", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

export function proxy(request: NextRequest): Response {
  // 1. Geo-block: the whole site, /admin and /api included (rule 6). The
  //    403 is returned directly; a rewrite to /blocked would lose the status
  //    (ADR 0026).
  if (shouldGeoBlock(request.headers)) return blockedResponse();

  // 2. A product slug that can never exist: plain 404, no render, no cache.
  if (isImpossibleProductPath(request.nextUrl.pathname)) {
    return productNotFound();
  }

  // 3. Coarse admin redirect: no session cookie at all → login page. A
  //    cookie that is present but invalid is let through and refused by
  //    requireAdmin() on the server.
  if (
    isAdminPage(request.nextUrl.pathname) &&
    !hasSessionCookie(request.headers)
  ) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

/*
 * Everything except Next's hashed build files and the favicon, which carry
 * no content worth blocking and are requested on every page. Image
 * optimisation (/_next/image), robots.txt and the sitemap stay covered.
 * The trailing "/" and "$" make the exclusions exact, so look-alikes such
 * as /_next/staticfoo or /favicon.ico.bak are still covered (QA L1).
 * Matcher values must be literal constants (proxy.md "Matcher").
 */
export const config = {
  matcher: ["/((?!_next/static/|favicon\\.ico$).*)"],
};
