// Tests for src/lib/security-headers.ts and its use in next.config.ts: the
// CSP directives (no eval in production, no plugins, no framing), the other
// headers, the whistleblower no-referrer override, the admin-only upload
// hosts in connect-src and the 403 page's headers.

import { modifyRouteRegex } from "next/dist/lib/redirect-status";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it, vi } from "vitest";

import nextConfig from "../../next.config";

import {
  BLOCKED_PAGE_HEADERS,
  adminConnectSrc,
  buildCsp,
  securityHeaders,
} from "./security-headers";

/* A CSP string as { directive: [sources] }. */
function parseCsp(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

const prod = parseCsp(buildCsp({ isDev: false, allowInlineScripts: true }));
const dev = parseCsp(buildCsp({ isDev: true, allowInlineScripts: true }));

describe("buildCsp", () => {
  it("never allows eval in production, only in dev", () => {
    expect(prod["script-src"]).not.toContain("'unsafe-eval'");
    expect(dev["script-src"]).toContain("'unsafe-eval'");
  });

  it("allows inline scripts only when asked", () => {
    expect(prod["script-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    const strict = parseCsp(
      buildCsp({ isDev: false, allowInlineScripts: false }),
    );
    expect(strict["script-src"]).toEqual(["'self'"]);
  });

  it("loads scripts, fonts and data from our own origin only", () => {
    expect(prod["default-src"]).toEqual(["'self'"]);
    expect(prod["font-src"]).toEqual(["'self'"]);
    expect(prod["connect-src"]).toEqual(["'self'"]);
    for (const sources of [prod["script-src"], prod["connect-src"]]) {
      expect(sources?.some((s) => s.startsWith("http"))).toBe(false);
    }
  });

  it("allows images and video from Cloudinary delivery only", () => {
    expect(prod["img-src"]).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://res.cloudinary.com",
    ]);
    expect(prod["media-src"]).toEqual(["'self'", "https://res.cloudinary.com"]);
  });

  it("refuses plugins, frames, framing, <base> tricks and cross-site form posts", () => {
    expect(prod["object-src"]).toEqual(["'none'"]);
    expect(prod["frame-src"]).toEqual(["'none'"]);
    expect(prod["frame-ancestors"]).toEqual(["'none'"]);
    expect(prod["base-uri"]).toEqual(["'self'"]);
    expect(prod["form-action"]).toEqual(["'self'"]);
  });

  it("upgrades insecure requests in production only", () => {
    expect(prod).toHaveProperty("upgrade-insecure-requests");
    expect(dev).not.toHaveProperty("upgrade-insecure-requests");
  });
});

describe("securityHeaders", () => {
  const headers = Object.fromEntries(
    securityHeaders({ isDev: false, allowInlineScripts: true }).map((h) => [
      h.key,
      h.value,
    ]),
  );

  it("sends HSTS for two years with subdomains, without preload", () => {
    expect(headers["Strict-Transport-Security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
  });

  it("sends the remaining hardening headers", () => {
    expect(headers).toMatchObject({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
    });
    expect(headers["Permissions-Policy"]).toContain("camera=()");
    expect(headers["Permissions-Policy"]).toContain("geolocation=()");
  });
});

describe("BLOCKED_PAGE_HEADERS", () => {
  it("lets the 403 page load nothing but its inline style", () => {
    const csp = BLOCKED_PAGE_HEADERS.find(
      (h) => h.key === "Content-Security-Policy",
    )?.value;
    expect(parseCsp(csp ?? "")).toEqual({
      "default-src": ["'none'"],
      "style-src": ["'unsafe-inline'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
      "frame-ancestors": ["'none'"],
    });
  });
});

describe("next.config.ts headers()", () => {
  async function rules(nodeEnv: string) {
    vi.stubEnv("NODE_ENV", nodeEnv);
    const headers = nextConfig.headers;
    if (!headers) throw new Error("next.config has no headers()");
    return headers();
  }

  it("applies the security headers to every path, with the production CSP", async () => {
    const [all] = await rules("production");
    expect(all?.source).toBe("/:path*");
    const csp = all?.headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toBe(
      buildCsp({ isDev: false, allowInlineScripts: true }),
    );
  });

  it("uses the dev CSP under next dev", async () => {
    const [all] = await rules("development");
    const csp = all?.headers.find((h) => h.key === "Content-Security-Policy");
    expect(csp?.value).toContain("'unsafe-eval'");
  });

  it("overrides Referrer-Policy with no-referrer on whistleblower pages, after the global rule", async () => {
    const list = await rules("production");
    const sources = list.map((rule) => rule.source);
    for (const source of ["/whistleblower", "/whistleblower/:path*"]) {
      const index = sources.indexOf(source);
      expect(index).toBeGreaterThan(sources.indexOf("/:path*"));
      expect(list[index]?.headers).toEqual([
        { key: "Referrer-Policy", value: "no-referrer" },
      ]);
    }
  });

  it("no longer enables the experimental SRI option", () => {
    expect(nextConfig.experimental).not.toHaveProperty("sri");
  });
});

/*
 * The production CSP for public pages, written out by hand from ADR 0027. It
 * must stay byte-for-byte the same when admin-only sources are added.
 */
const PUBLIC_PROD_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https://res.cloudinary.com; media-src 'self' https://res.cloudinary.com; " +
  "font-src 'self'; connect-src 'self'; frame-src 'none'; worker-src 'self'; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests";

const R2_ACCOUNT = "0123456789abcdef0123456789abcdef";
const R2_HOST = `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`;

describe("extraConnectSrc", () => {
  it("leaves the CSP unchanged when not given or empty", () => {
    expect(buildCsp({ isDev: false, allowInlineScripts: true })).toBe(
      PUBLIC_PROD_CSP,
    );
    expect(
      buildCsp({ isDev: false, allowInlineScripts: true, extraConnectSrc: [] }),
    ).toBe(PUBLIC_PROD_CSP);
  });

  it("adds the given origins to connect-src only", () => {
    const csp = buildCsp({
      isDev: false,
      allowInlineScripts: true,
      extraConnectSrc: ["https://api.cloudinary.com"],
    });
    expect(csp).toBe(
      PUBLIC_PROD_CSP.replace(
        "connect-src 'self';",
        "connect-src 'self' https://api.cloudinary.com;",
      ),
    );
  });
});

describe("adminConnectSrc", () => {
  it("adds Cloudinary's Upload API and the account's R2 endpoint", () => {
    expect(adminConnectSrc(R2_ACCOUNT)).toEqual([
      "https://api.cloudinary.com",
      R2_HOST,
    ]);
  });

  it("adds only Cloudinary when R2_ACCOUNT_ID is unset", () => {
    expect(adminConnectSrc(undefined)).toEqual(["https://api.cloudinary.com"]);
    expect(adminConnectSrc("")).toEqual(["https://api.cloudinary.com"]);
  });

  it.each([
    ["uppercase", R2_ACCOUNT.toUpperCase()],
    ["too short", "abc123"],
    ["a host injection", `${R2_ACCOUNT}.evil.example`],
    ["a source list", `${R2_ACCOUNT} https://evil.example`],
    ["a directive break", `${R2_ACCOUNT}; script-src *`],
  ])("throws for a malformed id (%s), without echoing it", (_label, id) => {
    expect(() => adminConnectSrc(id)).toThrow(/R2_ACCOUNT_ID is invalid/);
    try {
      adminConnectSrc(id);
    } catch (error) {
      expect((error as Error).message).not.toContain(id);
    }
  });
});

describe("next.config.ts headers() for /admin", () => {
  async function rules(env: Record<string, string>) {
    vi.stubEnv("NODE_ENV", "production");
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const headers = nextConfig.headers;
    if (!headers) throw new Error("next.config has no headers()");
    return headers();
  }

  /*
   * What Next sends for a path: every matching rule in order, a later rule
   * replacing an earlier one's value for the same key (installed docs:
   * 01-app/03-api-reference/05-config/01-next-config-js/headers.md, "Header
   * Overriding Behavior"). Matching uses Next's own matcher with the options
   * its router uses (server/lib/router-utils/filesystem.js buildCustomRoute).
   */
  function resolve(
    list: Awaited<ReturnType<typeof rules>>,
    path: string,
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const rule of list) {
      const match = getPathMatch(rule.source, {
        strict: true,
        removeUnnamedParams: true,
        regexModifier: (regex) => modifyRouteRegex(regex),
      });
      if (match(path) === false) continue;
      for (const header of rule.headers) out[header.key] = header.value;
    }
    return out;
  }

  const ADMIN_CSP = PUBLIC_PROD_CSP.replace(
    "connect-src 'self';",
    `connect-src 'self' https://api.cloudinary.com ${R2_HOST};`,
  );

  it("adds exactly the two upload hosts to connect-src on admin pages", async () => {
    const list = await rules({ R2_ACCOUNT_ID: R2_ACCOUNT });
    for (const path of ["/admin", "/admin/products", "/admin/products/x"]) {
      expect(resolve(list, path)["Content-Security-Policy"]).toBe(ADMIN_CSP);
    }
  });

  it("keeps every other security header on admin pages", async () => {
    const list = await rules({ R2_ACCOUNT_ID: R2_ACCOUNT });
    const admin = resolve(list, "/admin/products");
    const base = Object.fromEntries(
      securityHeaders({ isDev: false, allowInlineScripts: true }).map((h) => [
        h.key,
        h.value,
      ]),
    );
    expect(Object.keys(admin).sort()).toEqual(Object.keys(base).sort());
    for (const [key, value] of Object.entries(base)) {
      if (key !== "Content-Security-Policy") expect(admin[key]).toBe(value);
    }
  });

  it("leaves the public CSP byte-for-byte unchanged", async () => {
    const list = await rules({ R2_ACCOUNT_ID: R2_ACCOUNT });
    for (const path of [
      "/",
      "/products",
      "/product/arc-ar-013a",
      "/login",
      "/administrator",
      "/whistleblower",
      "/api/datasheet/x",
    ]) {
      expect(resolve(list, path)["Content-Security-Policy"]).toBe(
        PUBLIC_PROD_CSP,
      );
    }
  });

  it("lists the admin rule after the global one, with only a CSP", async () => {
    const list = await rules({ R2_ACCOUNT_ID: R2_ACCOUNT });
    const sources = list.map((rule) => rule.source);
    const admin = sources.indexOf("/admin/:path*");
    expect(admin).toBeGreaterThan(sources.indexOf("/:path*"));
    expect(list[admin]?.headers.map((h) => h.key)).toEqual([
      "Content-Security-Policy",
    ]);
  });

  it("adds only Cloudinary when R2_ACCOUNT_ID is unset", async () => {
    const list = await rules({ R2_ACCOUNT_ID: "" });
    expect(resolve(list, "/admin")["Content-Security-Policy"]).toBe(
      PUBLIC_PROD_CSP.replace(
        "connect-src 'self';",
        "connect-src 'self' https://api.cloudinary.com;",
      ),
    );
  });
});
