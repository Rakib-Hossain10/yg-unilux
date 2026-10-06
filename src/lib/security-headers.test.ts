// Tests for src/lib/security-headers.ts and its use in next.config.ts: the
// CSP directives (no eval in production, no plugins, no framing), the other
// headers, the whistleblower no-referrer override and the 403 page's headers.

import { describe, expect, it, vi } from "vitest";

import nextConfig from "../../next.config";

import {
  BLOCKED_PAGE_HEADERS,
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
