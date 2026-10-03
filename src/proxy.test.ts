// Tests for src/proxy.ts: the CN 403 across the whole site (pages, /admin,
// APIs, image optimisation), the coarse signed-out /admin redirect, and the
// matcher that leaves only build files and the favicon out.

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

/* NextResponse.next() marks "continue" with this header. */
const passedThrough = (response: Response) =>
  response.headers.get("x-middleware-next") === "1";

beforeEach(() => {
  resetGeoLogForTests();
  vi.stubEnv("GEO_BLOCK_ENABLED", "true");
});

describe("geo-block", () => {
  it.each([
    "/",
    "/product/arc-ar-013a",
    "/admin",
    "/login",
    "/api/auth/sign-in/email",
    "/api/datasheet/123",
    "/whistleblower",
    "/_next/image?url=x&w=640&q=75",
    "/robots.txt",
  ])("answers 403 to CN on %s", async (path) => {
    const response = proxy(request(path, { "x-vercel-ip-country": "CN" }));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not available in your region");
  });

  it("blocks a CN Server Action POST too", () => {
    const response = proxy(
      request("/admin/products", { "x-vercel-ip-country": "CN" }, "POST"),
    );
    expect(response.status).toBe(403);
  });

  it.each(["HK", "MO", "TW", "US"])("lets %s through", (country) => {
    const response = proxy(request("/", { "x-vercel-ip-country": country }));
    expect(passedThrough(response)).toBe(true);
  });

  it("lets CN through when GEO_BLOCK_ENABLED is false", () => {
    vi.stubEnv("GEO_BLOCK_ENABLED", "false");
    const response = proxy(request("/", { "x-vercel-ip-country": "CN" }));
    expect(passedThrough(response)).toBe(true);
  });

  it("blocks CN when GEO_BLOCK_ENABLED is malformed (fail closed)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GEO_BLOCK_ENABLED", "maybe");
    const response = proxy(request("/", { "x-vercel-ip-country": "CN" }));
    expect(response.status).toBe(403);
  });

  it("geo-blocks before the admin redirect", () => {
    const response = proxy(request("/admin", { "x-vercel-ip-country": "CN" }));
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("coarse /admin redirect", () => {
  it.each(["/admin", "/admin/products", "/admin/products/new"])(
    "sends a visitor with no session cookie from %s to /login",
    (path) => {
      const response = proxy(request(path));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`${BASE}/login`);
    },
  );

  it.each([
    ["dev cookie", "yg.session_token=abc"],
    ["https cookie", "__Secure-yg.session_token=abc"],
  ])("lets a request with a %s through to requireAdmin()", (_label, cookie) => {
    const response = proxy(request("/admin", { cookie }));
    expect(passedThrough(response)).toBe(true);
  });

  it("ignores cookies with other names", () => {
    const response = proxy(
      request("/admin", { cookie: "better-auth.session_token=abc; yg=1" }),
    );
    expect(response.status).toBe(307);
  });

  it.each(["/", "/administrator", "/api/admin/products", "/login"])(
    "does not redirect %s",
    (path) => {
      expect(passedThrough(proxy(request(path)))).toBe(true);
    },
  );
});

describe("matcher", () => {
  // The matcher is one path-to-regexp source with a single regex group; as
  // a plain anchored RegExp it matches the same paths.
  const [source] = config.matcher;
  const matches = (path: string) => new RegExp(`^${source}$`).test(path);

  it.each([
    "/",
    "/admin",
    "/api/auth/get-session",
    "/_next/image",
    "/robots.txt",
    "/sitemap.xml",
  ])("runs on %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each(["/_next/staticfoo", "/favicon.ico.bak"])(
    "still runs on %s",
    (path) => {
      expect(matches(path)).toBe(true);
    },
  );

  it.each(["/_next/static/chunks/app.js", "/favicon.ico"])(
    "skips %s",
    (path) => {
      expect(matches(path)).toBe(false);
    },
  );
});
