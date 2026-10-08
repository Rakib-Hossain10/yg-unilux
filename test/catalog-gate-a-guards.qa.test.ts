// QA gate A (Phase 4a): static guards for the catalog layer, rebuilt on the
// REAL TypeScript resolver (tsconfig paths, moduleResolution "bundler") and
// TypeScript's own import scanner instead of regexes, so "@/lib/catalog/./
// restricted", ".js" extensions, comments-in-strings and re-export chains
// cannot slip past. Adds what test/catalog-guards.test.ts does not check:
//  - TRANSITIVE: no cached catalog module reaches a session API through any
//    chain of imports (e.g. a helper that calls getViewer);
//  - nothing outside the one route reaches restricted.ts transitively either
//    (a re-export chain through another module counts);
//  - the allowed importer never wraps the reader in a cache.
// Also pins the bypasses the dev's regex guard misses (finding L-3).

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile).config,
  ts.sys,
  root,
);
const options = parsed.options;
const host = ts.createCompilerHost(options);

const norm = (p: string) => {
  const real = existsSync(p) ? realpathSync.native(p) : p;
  const rel = path.relative(root, real).replaceAll("\\", "/");
  return process.platform === "win32" ? rel.toLowerCase() : rel;
};

const RESTRICTED = norm(path.join(SRC, "lib/catalog/restricted.ts"));
const ALLOWED_RESTRICTED_IMPORTERS = new Set(
  [path.join(SRC, "app/api/catalog/restricted/[productId]/route.ts")].map(norm),
);

/* Bare specifiers that read the request/session. */
const SESSION_BARE = [
  /^next\/headers$/,
  /^better-auth(\/|$)/,
  /^next\/dist\/.*headers/,
];
/* Our own session modules. */
const SESSION_FILES = new Set(
  [
    "lib/permissions.ts",
    "lib/auth.ts",
    "lib/auth-handler.ts",
    "lib/session-cookie.ts",
  ].map((f) => norm(path.join(SRC, f))),
);

interface Edge {
  spec: string;
  file: string | null; // resolved project file, null = package / unresolved
}

const edgeCache = new Map<string, Edge[]>();
function edges(file: string): Edge[] {
  const key = norm(file);
  const hit = edgeCache.get(key);
  if (hit) return hit;
  const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  const specs = info.importedFiles.map((f) => f.fileName);
  const out = specs.map((spec): Edge => {
    const r = ts.resolveModuleName(spec, file, options, host).resolvedModule;
    const resolved =
      r &&
      !r.isExternalLibraryImport &&
      !r.resolvedFileName.includes("node_modules")
        ? r.resolvedFileName
        : null;
    return { spec, file: resolved };
  });
  edgeCache.set(key, out);
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        /\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(e.name) &&
        !/\.test\.[jt]sx?$/.test(e.name),
    )
    .map((e) => path.join(e.parentPath, e.name));
}

/* Every path from `start` to a node matching `hit`, as readable chains. */
function reach(start: string, hit: (e: Edge) => boolean): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const stack: [string, string[]][] = [[start, [norm(start)]]];
  while (stack.length > 0) {
    const [file, trail] = stack.pop() as [string, string[]];
    if (seen.has(norm(file))) continue;
    seen.add(norm(file));
    for (const e of edges(file)) {
      if (hit(e))
        found.push([...trail, e.file ? norm(e.file) : e.spec].join(" -> "));
      if (e.file && !/\.d\.ts$/.test(e.file))
        stack.push([e.file, [...trail, norm(e.file)]]);
    }
  }
  return found;
}

const isSession = (e: Edge) =>
  (e.file !== null && SESSION_FILES.has(norm(e.file))) ||
  (e.file === null && SESSION_BARE.some((re) => re.test(e.spec)));

const CACHED_MODULES = [
  "product.ts",
  "family.ts",
  "related.ts",
  "categories.ts",
  "view.ts",
  // Phase 4b gate A (L1-L2): listing, facets, areas, search and helpers.
  "listing.ts",
  "listing-params.ts",
  "listing-scope.ts",
  "facets.ts",
  "areas.ts",
  "category-path.ts",
  "search.ts",
  // Imported by search.ts (index name); also by the CLI script.
  "search-index.ts",
  "cache-version.ts",
]
  .map((f) => path.join(SRC, "lib/catalog", f))
  // Public, session-free entry points that use the cached readers.
  .concat([path.join(SRC, "app/api/catalog/search/route.ts")]);

describe("catalog guards on the real TypeScript resolver", () => {
  it("resolver sanity: alias, ./ segments and .js extensions resolve to restricted.ts", () => {
    const from = path.join(SRC, "lib/qa-probe.ts");
    for (const spec of [
      "@/lib/catalog/restricted",
      "@/lib/catalog/./restricted",
      "@/lib/catalog/../catalog/restricted",
      "@/lib/catalog/restricted.js",
      "./catalog/restricted",
    ]) {
      const r = ts.resolveModuleName(spec, from, options, host).resolvedModule;
      expect(r && norm(r.resolvedFileName), spec).toBe(RESTRICTED);
    }
  });

  it("positive control: restricted.ts DOES reach the session (the walker works)", () => {
    const chains = reach(
      path.join(SRC, "lib/catalog/restricted.ts"),
      isSession,
    );
    expect(chains.some((c) => c.includes("src/lib/permissions.ts"))).toBe(true);
    expect(chains.some((c) => c.endsWith("next/headers"))).toBe(true);
  });

  it.each(CACHED_MODULES.map((f) => [path.basename(f), f]))(
    "%s reaches no session API through ANY import chain",
    (_n, file) => {
      expect(reach(file, isSession)).toEqual([]);
    },
  );

  it.each(CACHED_MODULES.map((f) => [path.basename(f), f]))(
    "%s never reaches restricted.ts",
    (_n, file) => {
      expect(
        reach(file, (e) => e.file !== null && norm(e.file) === RESTRICTED),
      ).toEqual([]);
    },
  );

  it("no module in src reaches restricted.ts except via the one allowed route", () => {
    const offenders = sourceFiles(SRC)
      .filter(
        (f) =>
          norm(f) !== RESTRICTED && !ALLOWED_RESTRICTED_IMPORTERS.has(norm(f)),
      )
      .flatMap((f) =>
        reach(f, (e) => e.file !== null && norm(e.file) === RESTRICTED).filter(
          // a chain that passes through the allowed route is fine (it guards)
          (chain) =>
            ![...ALLOWED_RESTRICTED_IMPORTERS].some((a) => chain.includes(a)),
        ),
      );
    expect(offenders).toEqual([]);
  }, 60_000); // walks every src file through the TS resolver

  it("restricted.ts and its allowed importer never use a cache wrapper", () => {
    for (const file of [
      path.join(SRC, "lib/catalog/restricted.ts"),
      ...[...ALLOWED_RESTRICTED_IMPORTERS].map((p) => path.join(root, p)),
    ]) {
      if (!existsSync(file)) continue; // the route arrives in P7
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(
        /unstable_cache|["']use cache|cacheTag|cacheLife|revalidate\s*=\s*\d/,
      );
      expect(
        edges(file).map((e) => e.spec),
        file,
      ).not.toContain("next/cache");
    }
  });

  it("no catalog module uses a non-literal dynamic import (unscannable)", () => {
    for (const file of sourceFiles(path.join(SRC, "lib/catalog"))) {
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/\b(import|require)\s*\(\s*[^"'`\s)]/);
      expect(code, file).not.toMatch(/\b(import|require)\s*\(\s*`[^`]*\$\{/);
    }
  });
});

/*
 * FINDING L-3: the dev guard (test/catalog-guards.test.ts) resolves "@/x" by
 * string prefix only, without normalising, and only accepts ".ts". These
 * specifiers reach restricted.ts (proven by the resolver above) but its
 * RESTRICTED_MODULE regex does not match them, so an extra importer would
 * pass that guard. The resolver-based guard above catches them.
 */
describe("FINDING L-3: specifiers the regex guard misses", () => {
  const RESTRICTED_MODULE = /^src\/lib\/catalog\/restricted(\.ts)?$/; // copied from the dev guard
  const devResolved = (spec: string) =>
    spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec;
  it.each([
    "@/lib/catalog/./restricted",
    "@/lib/catalog/restricted.js",
    "@/lib/catalog//restricted",
    "@/lib/catalog/../catalog/restricted",
  ])("%s resolves to restricted.ts but the dev regex says no", (spec) => {
    const r = ts.resolveModuleName(
      spec,
      path.join(SRC, "lib/qa-probe.ts"),
      options,
      host,
    ).resolvedModule;
    expect(r && norm(r.resolvedFileName)).toBe(RESTRICTED);
    expect(RESTRICTED_MODULE.test(devResolved(spec))).toBe(false);
  });
});
