// Runs before every request (Next.js 16 "proxy", ADR 0007): blocks mainland
// China with a 403 (ADR 0003, 0026), then sends obviously signed-out visitors
// from /admin to /login. It is never the only guard: requireAdmin() is.

import { type NextRequest, NextResponse } from "next/server";

import { blockedResponse, shouldGeoBlock } from "@/lib/geo";
import { hasSessionCookie } from "@/lib/session-cookie";

/** /admin and everything under it (admin pages; admin APIs live under /api). */
function isAdminPage(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export function proxy(request: NextRequest): Response {
  // 1. Geo-block: the whole site, /admin and /api included (rule 6). The
  //    403 is returned directly; a rewrite to /blocked would lose the status
  //    (ADR 0026).
  if (shouldGeoBlock(request.headers)) return blockedResponse();

  // 2. Coarse admin redirect: no session cookie at all → login page. A
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
