// Tests for src/lib/safe-next-path.ts: known attacks by example, then a
// seeded property test (no extra dependency) that throws random mixes of
// dangerous fragments at it and checks no accepted value leaves the origin.

import { describe, expect, it } from "vitest";

import { MAX_NEXT_PATH_LENGTH, safeNextPath } from "./safe-next-path";

describe("safeNextPath: accepted", () => {
  it.each([
    "/",
    "/my-downloads",
    "/product/arc-ar-013a",
    "/product/arc-ar-013a?model=AR-013A2",
    "/products/spot-lights/recessed?cct=3000K&page=2",
    "/search?q=led%2Bstrip",
    "/areas/retail#top",
    // Dots inside a segment, and dot segments in the query, are fine.
    "/product/arc.v2",
    "/products/...",
    "/search?q=../x",
    "/areas/retail#/../x",
  ])("%s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });
});

describe("safeNextPath: refused", () => {
  it.each([
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with path", "//evil.example/login"],
    ["backslash host", "/\\evil.example"],
    ["double backslash", "\\\\evil.example"],
    ["backslash anywhere", "/products\\..\\x"],
    ["absolute https", "https://evil.example/"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,x"],
    ["relative", "my-downloads"],
    ["dot relative", "./x"],
    ["empty", ""],
    ["tab before slash", "/\t/evil.example"],
    ["newline", "/x\n/y"],
    ["NUL", "/x\u0000"],
    ["space", "/x y"],
    ["non-ASCII", "/produkt/ä"],
    ["encoded slash pair", "/%2F%2Fevil.example"],
    ["encoded leading slash", "%2F%2Fevil.example"],
    ["encoded backslash", "/%5Cevil.example"],
    ["double-encoded slash pair", "/%252F%252Fevil.example"],
    ["encoded tab", "/%09/evil.example"],
    ["encoded newline", "/x%0d%0aSet-Cookie:a=b"],
    ["malformed encoding", "/%E0%A4%A"],
    ["lone percent", "/100%"],
    ["deeply nested encoding", "/%2525252525252F"],
    // Dot segments (QA L-2): the URL parser resolves these to "//evil".
    ["dot-dot then //", "/..//evil.example"],
    ["dot then //", "/.//evil.example"],
    ["nested dot-dot then //", "/a/..//evil.example"],
    ["encoded dot-dot", "/%2e%2e//evil.example"],
    ["mixed-case encoded dot", "/%2E//evil.example"],
    ["half-encoded dot-dot", "/.%2e//evil.example"],
    ["double-encoded dot-dot", "/%252e%252e//evil.example"],
    ["trailing dot-dot", "/products/.."],
    ["trailing dot", "/products/."],
    ["dot segment before query", "/a/../b?x=1"],
    // Only the resolved-pathname check catches this one: the decoded "?"
    // hides the dot segment from the per-layer check.
    ["dot-dot hidden behind encoded ?", "/a%3F/%2e%2e//evil.example"],
  ])("%s", (_label, path) => {
    expect(safeNextPath(path)).toBeNull();
  });

  it("refuses non-strings", () => {
    for (const value of [undefined, null, 42, ["/"], { path: "/" }]) {
      expect(safeNextPath(value)).toBeNull();
    }
  });

  it("refuses overlong input but accepts the maximum length", () => {
    const max = `/${"a".repeat(MAX_NEXT_PATH_LENGTH - 1)}`;
    expect(safeNextPath(max)).toBe(max);
    expect(safeNextPath(`${max}a`)).toBeNull();
  });
});

/* Mulberry32: a tiny seeded PRNG, so a failure always reproduces. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  "/",
  "//",
  "\\",
  "%2F",
  "%2f",
  "%5C",
  "%5c",
  "%25",
  "%252F",
  "%09",
  "%0A",
  "%00",
  "\t",
  "\n",
  " ",
  ":",
  "@",
  "?",
  "#",
  ".",
  "..",
  "%2e",
  "%2e%2e",
  "evil.example",
  "javascript:",
  "https:",
  "a",
  "products",
  "%",
  "%E2%80%AE",
  " ",
  "／",
];

describe("safeNextPath: property", () => {
  it("never accepts a value that resolves to another origin or hides a // or \\", () => {
    const random = prng(0x5afe);
    const base = "https://site.invalid";
    let accepted = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const parts = 1 + Math.floor(random() * 8);
      let candidate = random() < 0.7 ? "/" : "";
      for (let p = 0; p < parts; p += 1) {
        candidate += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      }
      const result = safeNextPath(candidate);
      if (result === null) continue;
      accepted += 1;
      // Accepted values are returned unchanged.
      expect(result).toBe(candidate);
      // They stay on the origin, also after any number of decodes.
      expect(new URL(result, base).origin).toBe(base);
      // ...and their resolved path is never protocol-relative (QA L-2).
      expect(new URL(result, base).pathname.startsWith("//")).toBe(false);
      let decoded = result;
      for (let round = 0; round < 6; round += 1) {
        expect(decoded.startsWith("/")).toBe(true);
        expect(decoded.startsWith("//")).toBe(false);
        expect(decoded).not.toMatch(/[\\\s\x00-\x1f\x7f]/);
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
    }
    // The generator must also produce safe paths, or the test proves nothing.
    expect(accepted).toBeGreaterThan(100);
  });
});
