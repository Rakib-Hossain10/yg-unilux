// QA (task 8 review): extra proxy checks the feature tests don't cover.
// Header edge cases, every HTTP method, fail-closed on a blank switch, no IP
// headers read (rule 7), no open redirect, and the matcher as Next compiles it.

import { createRequire } from "node:module";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetGeoLogForTests } from "./lib/geo";
import { config, proxy } from "./proxy";

const BASE = "http://localhost:3000";

function request(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): NextRequest {
  return new NextRequest(new URL(path, BASE), { headers, method });
}

const passedThrough = (response: Response) =>
  response.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  resetGeoLogForTests();
  vi.stubEnv("GEO_BLOCK_ENABLED", "true");
});

describe("geo-block: methods and header shapes", () => {
  it.each(["HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"])(
    "answers 403 to a CN %s",
    (method) => {
      const response = proxy(
        request(
          "/api/auth/sign-in/email",
          { "x-vercel-ip-country": "CN" },
          method,
        ),
      );
      expect(response.status).toBe(403);
    },
  );

  // Vercel sets one two-letter value. A comma list can only come from a
  // client on a host that doesn't overwrite the header, where the header is
  // untrusted anyway; pin that it is not treated as CN.
  it.each(["CN, US", "US, CN", "C N", "CNN", "CN-"])(
    "does not treat %j as CN (exact match only)",
    (country) => {
      const response = proxy(request("/", { "x-vercel-ip-country": country }));
      expect(passedThrough(response)).toBe(true);
    },
  );

  it("blocks CN when GEO_BLOCK_ENABLED is whitespace only (fail closed)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GEO_BLOCK_ENABLED", "   ");
    const response = proxy(request("/", { "x-vercel-ip-country": "CN" }));
    expect(response.status).toBe(403);
  });

  it("treats an empty GEO_BLOCK_ENABLED as off", () => {
    vi.stubEnv("GEO_BLOCK_ENABLED", "");
    const response = proxy(request("/", { "x-vercel-ip-country": "CN" }));
    expect(passedThrough(response)).toBe(true);
  });

  it("is not cacheable by a shared cache and sets no cookie", () => {
    const response = proxy(request("/", { "x-vercel-ip-country": "CN" }));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("rule 7: the proxy reads no IP header", () => {
  it.each([
    ["/whistleblower", {}],
    ["/whistleblower", { "x-vercel-ip-country": "CN" }],
    ["/admin", {}],
  ])("on %s reads only the country and cookie headers", (path, extra) => {
    const req = request(path, {
      ...extra,
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.9",
    });
    const get = vi.spyOn(req.headers, "get");
    proxy(req);
    const names = get.mock.calls.map(([name]) => name.toLowerCase());
    for (const name of names) {
      expect(["x-vercel-ip-country", "cookie"]).toContain(name);
    }
  });
});

describe("coarse /admin redirect: no open redirect, no bypass", () => {
  it.each([
    "/admin?next=//evil.example",
    "/admin?redirect=https://evil.example",
    "/admin/products?callbackURL=https://evil.example",
  ])("%s goes to a bare same-origin /login", (path) => {
    const response = proxy(request(path));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${BASE}/login`);
  });

  // Next does not decode or case-fold paths when routing (checked live with
  // next start: /%61dmin, /ADMIN, /admin;x, /admin%2F all 404), so these
  // never reach an admin page and need no redirect. requireAdmin() is the
  // guard either way.
  it.each(["/%61dmin", "/ADMIN", "/Admin"])(
    "leaves %s to Next's router (404)",
    (path) => {
      expect(passedThrough(proxy(request(path)))).toBe(true);
    },
  );

  it("an empty session cookie value still redirects", () => {
    const response = proxy(request("/admin", { cookie: "yg.session_token=" }));
    expect(response.status).toBe(307);
  });
});

/*
 * The matcher as Next 16.3.7 actually compiles it (an optional
 * /_next/data/<id> prefix and .json/.rsc/.segments suffixes are added).
 * Internal API: if it moves on an upgrade, re-check the matcher by hand.
 */
describe("matcher as compiled by Next", () => {
  const require = createRequire(import.meta.url);
  const { getMiddlewareMatchers } =
    require("next/dist/build/analysis/get-page-static-info.js") as {
      getMiddlewareMatchers: (
        source: unknown,
        nextConfig: { basePath: string; i18n?: undefined },
      ) => { regexp: string }[];
    };
  const compiled = getMiddlewareMatchers(config.matcher, { basePath: "" });
  const runs = (path: string) =>
    compiled.some(({ regexp }) => new RegExp(regexp).test(path));

  it.each([
    "/",
    "/admin",
    "/admin.rsc",
    "/admin.segments/_tree.segment.rsc",
    "/_next/data/build-id/admin.json",
    "/_next/image",
    "/api/datasheet/123",
    "/whistleblower",
    "/robots.txt",
    "/sitemap.xml",
    "/logo.svg",
  ])("runs on %s", (path) => {
    expect(runs(path)).toBe(true);
  });

  it.each([
    "/_next/static/chunks/app.js",
    "/_next/static/media/f.woff2",
    "/favicon.ico",
  ])("skips %s", (path) => {
    expect(runs(path)).toBe(false);
  });

  // QA L1 (fixed): the exclusions are anchored ("_next/static/" and
  // "favicon\.ico$"), so look-alike paths still get the CN 403 instead of
  // Next's 404 page with the site chrome.
  it.each(["/_next/staticfoo", "/favicon.icofoo", "/favicon.ico.bak"])(
    "runs on %s (prefix gap)",
    (path) => {
      expect(runs(path)).toBe(true);
    },
  );
});
