// Static guards for the catalog layer (ADR 0002, 0063), on the real
// TypeScript resolver and TRANSITIVE: no catalog module except restricted.ts
// reaches a session API through any import chain, restricted.ts is never
// cached, and nothing but the dynamic restricted block reaches restricted.ts
// (directly or through a re-export chain). Replaces the earlier regex guard
// that "./", ".js" and "//" specifiers slipped past (gate A finding L-2).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  importEdges,
  norm,
  reachingChains,
  resolveSpecifier,
  sourceFiles,
  SRC,
  type ImportEdge,
} from "./helpers/module-graph";

const CATALOG_DIR = path.join(SRC, "lib", "catalog");
const RESTRICTED_FILE = path.join(CATALOG_DIR, "restricted.ts");
const RESTRICTED = norm(RESTRICTED_FILE);

/** The one module allowed to import the restricted reader (task P7). */
const RESTRICTED_IMPORTERS = new Set(
  [path.join(SRC, "app/api/catalog/restricted/[productId]/route.ts")].map(norm),
);

/* Our own modules that read the request or the session. */
const SESSION_FILES = new Set(
  [
    "lib/permissions.ts",
    "lib/auth.ts",
    "lib/auth-handler.ts",
    "lib/session-cookie.ts",
  ].map((file) => norm(path.join(SRC, file))),
);
/* Packages that read the request or the session. */
const SESSION_PACKAGES = [
  /^next\/headers$/,
  /^better-auth(\/|$)/,
  /^next\/dist\/.*headers/,
];

const readsSession = (edge: ImportEdge): boolean =>
  edge.file !== null
    ? SESSION_FILES.has(norm(edge.file))
    : SESSION_PACKAGES.some((re) => re.test(edge.spec));

const reachesRestricted = (edge: ImportEdge): boolean =>
  edge.file !== null && norm(edge.file) === RESTRICTED;

describe("catalog layer guards (TypeScript resolver, transitive)", () => {
  const catalogFiles = sourceFiles(CATALOG_DIR);
  const cachedFiles = catalogFiles.filter((file) => norm(file) !== RESTRICTED);

  it("finds the catalog modules", () => {
    expect(catalogFiles.map(norm)).toEqual(
      expect.arrayContaining(
        [
          "areas.ts",
          "categories.ts",
          "category-path.ts",
          "facets.ts",
          "family.ts",
          "listing.ts",
          "listing-params.ts",
          "listing-scope.ts",
          "product.ts",
          "related.ts",
          "restricted.ts",
          "view.ts",
        ].map((file) => norm(path.join(CATALOG_DIR, file))),
      ),
    );
  });

  it("resolves look-alike specifiers to restricted.ts (the guard sees them)", () => {
    const from = path.join(SRC, "lib", "guard-probe.ts");
    for (const spec of [
      "@/lib/catalog/restricted",
      "@/lib/catalog/./restricted",
      "@/lib/catalog//restricted",
      "@/lib/catalog/../catalog/restricted",
      "@/lib/catalog/restricted.js",
      "./catalog/restricted",
    ]) {
      const file = resolveSpecifier(spec, from);
      expect(file && norm(file), spec).toBe(RESTRICTED);
    }
  });

  it("restricted.ts does reach the session (positive control)", () => {
    expect(reachingChains(RESTRICTED_FILE, readsSession)).not.toEqual([]);
  });

  it("lets no other catalog module reach the session through any chain", () => {
    expect(
      cachedFiles.flatMap((file) => reachingChains(file, readsSession)),
    ).toEqual([]);
  });

  it("keeps restricted.ts out of every cache", () => {
    const code = readFileSync(RESTRICTED_FILE, "utf8");
    expect(importEdges(RESTRICTED_FILE).map((edge) => edge.spec)).not.toContain(
      "next/cache",
    );
    expect(code).not.toMatch(/unstable_cache|["']use cache|cacheTag|cacheLife/);
  });

  it("lets only the dynamic restricted block reach restricted.ts", () => {
    const offenders = sourceFiles(SRC)
      .filter(
        (file) =>
          norm(file) !== RESTRICTED && !RESTRICTED_IMPORTERS.has(norm(file)),
      )
      .flatMap((file) =>
        reachingChains(file, reachesRestricted).filter(
          // A chain through the allowed route is guarded by that route.
          (chain) =>
            ![...RESTRICTED_IMPORTERS].some((allowed) =>
              chain.includes(allowed),
            ),
        ),
      );
    expect(offenders).toEqual([]);
  }, 60_000);

  it("keeps listing-params.ts client-safe: pure imports only (Phase 4b L1)", () => {
    const file = path.join(CATALOG_DIR, "listing-params.ts");
    const allowed = new Set(
      [
        "lib/slug.ts",
        "models/product-constants.ts",
        "models/spec-columns.ts",
      ].map((f) => norm(path.join(SRC, f))),
    );
    // No "server-only", no database, no Next: only Zod and pure modules.
    for (const edge of importEdges(file)) {
      if (edge.file === null) expect(edge.spec).toBe("zod");
      else expect(allowed.has(norm(edge.file)), edge.spec).toBe(true);
    }
  });

  it("has no barrel that could re-export the restricted reader", () => {
    expect(catalogFiles.some((file) => /[\\/]index\.[jt]sx?$/.test(file))).toBe(
      false,
    );
  });
});
