// Tests for src/lib/geo.ts: the country matrix (only CN, never HK/MO/TW),
// the GEO_BLOCK_ENABLED switch failing closed when malformed, and the
// self-contained 403 page.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnvError } from "./env";
import {
  blockedResponse,
  geoBlockOn,
  isBlockedCountry,
  resetGeoLogForTests,
  shouldGeoBlock,
} from "./geo";

const from = (country?: string) =>
  new Headers(country === undefined ? {} : { "x-vercel-ip-country": country });

beforeEach(() => {
  resetGeoLogForTests();
});

describe("isBlockedCountry", () => {
  it.each(["CN", "cn", " CN "])("blocks %j", (country) => {
    expect(isBlockedCountry(from(country))).toBe(true);
  });

  it.each(["HK", "MO", "TW", "US", "SG", "CN-HK", "CHN", "XX", ""])(
    "never blocks %j",
    (country) => {
      expect(isBlockedCountry(from(country))).toBe(false);
    },
  );

  it("does not block without a country header (local dev)", () => {
    expect(isBlockedCountry(from())).toBe(false);
  });
});

describe("geoBlockOn (GEO_BLOCK_ENABLED)", () => {
  it.each([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ])("reads %j as %s", (value, expected) => {
    vi.stubEnv("GEO_BLOCK_ENABLED", value);
    expect(geoBlockOn()).toBe(expected);
  });

  it("is off when unset", () => {
    vi.stubEnv("GEO_BLOCK_ENABLED", undefined);
    expect(geoBlockOn()).toBe(false);
  });

  it("fails closed on a malformed value and logs once, without the value", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("GEO_BLOCK_ENABLED", "yes-please-secret");
    expect(geoBlockOn()).toBe(true);
    expect(geoBlockOn()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("GEO_BLOCK_ENABLED");
    expect(line).not.toContain("yes-please-secret");
  });

  it("rethrows anything that isn't an EnvError", () => {
    expect(() =>
      geoBlockOn(() => {
        throw new TypeError("boom");
      }),
    ).toThrow(TypeError);
  });

  it("treats an EnvError from the reader as on", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      geoBlockOn(() => {
        throw new EnvError("the geo-block switch", [
          {
            kind: "invalid",
            variable: "GEO_BLOCK_ENABLED",
            expected: '"true" or "false"',
          },
        ]);
      }),
    ).toBe(true);
  });
});

describe("shouldGeoBlock", () => {
  it("blocks CN only when the switch is on", () => {
    expect(shouldGeoBlock(from("CN"), () => true)).toBe(true);
    expect(shouldGeoBlock(from("CN"), () => false)).toBe(false);
    expect(shouldGeoBlock(from("HK"), () => true)).toBe(false);
  });

  it("never reads the switch for other countries", () => {
    const readFlag = vi.fn(() => true);
    shouldGeoBlock(from("TW"), readFlag);
    shouldGeoBlock(from(), readFlag);
    expect(readFlag).not.toHaveBeenCalled();
  });
});

describe("blockedResponse", () => {
  it("is a private, uncacheable 403 HTML page", async () => {
    const response = blockedResponse();
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("x-vercel-ip-country");
    const html = await response.text();
    expect(html).toContain("not available in your region");
  });

  it("loads nothing else from the site (no scripts, links or images)", async () => {
    const html = await blockedResponse().text();
    expect(html).not.toMatch(/<script|<link|<img|src=|href=|url\(/i);
  });
});
