// QA gate A (Phase 5): static guards that close the evasion gaps of
// src/lib/account-writes.guard.test.ts (ADR 0068 "one writer"), plus the
// no-store contract of the two new route handlers.
//
// The existing guard matches `internalAdapter.updateUser(` and
// `collection("users").update…` literally, so an alias
// (`const ia = ctx.context.internalAdapter; ia.updateUser(…)`), a typed
// collection (`collection<Doc>("users")`), a `.js`/`.mjs` script or an
// aggregation `$merge` into `users` would slip through. These checks are
// alias-proof: ANY `.updateUser…(` call, and ANY raw handle on Better
// Auth's collections, outside the sanctioned files fails the build.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ROOTS = ["src", "scripts"].map((dir) => join(ROOT, dir));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const isSource = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name);
    const isTest = /\.test\.(ts|tsx|js|mjs)$/.test(entry.name);
    return isSource && !isTest ? [path] : [];
  });
}

const files = ROOTS.flatMap(sourceFiles).map((path) => ({
  name: relative(ROOT, path).split(sep).join("/"),
  // Comments may mention the forbidden calls; strip them first.
  text: readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1"),
}));

const matching = (pattern: RegExp) =>
  files.filter((f) => pattern.test(f.text)).map((f) => f.name);

describe("one writer for users, alias-proof (ADR 0068)", () => {
  it("scans .ts/.tsx/.mts/.js/.mjs sources in src/ and scripts/", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.name === "src/lib/account-writes.ts")).toBe(
      true,
    );
  });

  it("only account-writes.ts calls any …updateUser…() (whatever the receiver)", () => {
    expect(matching(/\.\s*updateUser\w*\s*\(/)).toEqual([
      "src/lib/account-writes.ts",
    ]);
  });

  it("no source takes a raw handle on Better Auth's collections", () => {
    expect(
      matching(
        /collection\s*(<[^>]*>)?\s*\(\s*["'`](users|verifications|sessions|accounts|rateLimits)["'`]/,
      ),
    ).toEqual([]);
  });

  it("no aggregation writes into users ($merge / $out)", () => {
    expect(matching(/\$(merge|out)\b[\s\S]{0,80}?["'`]users["'`]/)).toEqual([]);
  });

  it("internalAdapter user/verification writes stay in the sanctioned files", () => {
    // Writes that touch users or verifications by any internalAdapter name.
    const writes =
      /internalAdapter[\s\S]{0,40}?\.\s*(createUser|deleteUser|updateUser\w*|createVerificationValue|deleteVerification\w*|updateVerification\w*)\s*\(/;
    expect(matching(writes).sort()).toEqual(
      // invite.ts creates the hashed invite token (ADR 0068 point 1).
      ["src/lib/account-writes.ts", "src/lib/invite.ts"].sort(),
    );
  });
});

describe("self-test: the patterns catch the evasions", () => {
  it.each([
    [
      "aliased adapter",
      "const ia = ctx.context.internalAdapter; await ia.updateUser(id, x);",
      /\.\s*updateUser\w*\s*\(/,
    ],
    [
      "typed collection",
      'getDb().collection<Doc>("users").updateOne(q, u)',
      /collection\s*(<[^>]*>)?\s*\(\s*["'`](users|verifications|sessions|accounts|rateLimits)["'`]/,
    ],
    [
      "$merge",
      '{ $merge: { into: "users" } }',
      /\$(merge|out)\b[\s\S]{0,80}?["'`]users["'`]/,
    ],
  ])("%s", (_label, sample, pattern) => {
    expect(pattern.test(sample)).toBe(true);
  });
});

describe("the new route handlers are never cached", () => {
  const routes = [
    "src/app/api/datasheet/[productId]/route.ts",
    "src/app/api/cron/access-expiry/route.ts",
  ];

  it.each(routes)(
    "%s: Node runtime, connection(), private no-store only",
    (name) => {
      const text = readFileSync(join(ROOT, name), "utf8");
      expect(text).toMatch(/export const runtime = "nodejs"/);
      expect(text).toMatch(/await connection\(\)/);
      const cacheValues = [
        ...text.matchAll(
          /["']private, no-store["']|Cache-Control["']?\s*:\s*([^,\n}]+)/g,
        ),
      ].map((m) => m[0]);
      expect(cacheValues.length).toBeGreaterThan(0);
      // No other cache directive anywhere in the handler.
      expect(text).not.toMatch(
        /s-maxage|max-age=[1-9]|stale-while|public[,"']/,
      );
      expect(text).not.toMatch(
        /export const (revalidate|dynamic)\s*=\s*["']?(force-static|\d)/,
      );
    },
  );
});

describe("no secret reaches the browser", () => {
  it("no NEXT_PUBLIC_ variable is read in src/", () => {
    expect(matching(/NEXT_PUBLIC_/)).toEqual([]);
  });

  it("CRON_SECRET is read only through env.ts", () => {
    expect(
      matching(/process\.env\.CRON_SECRET|process\.env\[["']CRON_SECRET/),
    ).toEqual([]);
  });
});
