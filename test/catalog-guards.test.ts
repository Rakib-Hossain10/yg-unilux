// Static guards for the catalog layer (ADR 0002, 0063): only restricted.ts
// may read the session (permissions/auth/headers), restricted.ts is never
// cached, and only the dynamic restricted block may import it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_DIR = path.join(root, "src", "lib", "catalog");

/** The one module allowed to import the restricted reader (task P7). */
const RESTRICTED_IMPORTERS: readonly string[] = [
  "src/app/api/catalog/restricted/[productId]/route.ts",
];

const isSource = (name: string) =>
  /\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(name) && !/\.test\.[jt]sx?$/.test(name);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && isSource(entry.name))
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .replaceAll("\\", "/"),
    )
    .sort();
}

/* Every module specifier: import/export from, import(), require(). */
function specifiers(file: string): string[] {
  const code = readFileSync(path.join(root, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["'`]([^"'`]+)["'`]/g,
    /\bimport\s*["'`]([^"'`]+)["'`]/g,
    /\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1] ?? "");
  }
  return found;
}

/* Resolves "./x" / "../x" against the file; "@/x" to "src/x". */
function resolved(file: string, spec: string): string {
  if (spec.startsWith("@/")) return `src/${spec.slice(2)}`;
  if (spec.startsWith(".")) {
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(file), spec),
    );
  }
  return spec;
}

const SESSION_MODULES = [
  /^src\/lib\/permissions(\.ts|\/index(\.ts)?)?$/,
  /^src\/lib\/auth(\.ts|\/index(\.ts)?)?$/,
  /^src\/lib\/auth-handler(\.ts)?$/,
  /^src\/lib\/session-cookie(\.ts)?$/,
  /^next\/headers$/,
  /^better-auth(\/|$)/,
];
const RESTRICTED_MODULE = /^src\/lib\/catalog\/restricted(\.ts)?$/;

describe("catalog layer guards", () => {
  const catalogFiles = sourceFiles(CATALOG_DIR);

  it("finds the catalog modules", () => {
    expect(catalogFiles).toEqual(
      expect.arrayContaining([
        "src/lib/catalog/categories.ts",
        "src/lib/catalog/family.ts",
        "src/lib/catalog/product.ts",
        "src/lib/catalog/related.ts",
        "src/lib/catalog/restricted.ts",
        "src/lib/catalog/view.ts",
      ]),
    );
  });

  it("lets only restricted.ts read the session", () => {
    const offenders = catalogFiles
      .filter((file) => file !== "src/lib/catalog/restricted.ts")
      .flatMap((file) =>
        specifiers(file)
          .map((spec) => resolved(file, spec))
          .filter((target) => SESSION_MODULES.some((re) => re.test(target)))
          .map((target) => `${file} -> ${target}`),
      );
    expect(offenders).toEqual([]);
  });

  it("keeps restricted.ts out of every cache", () => {
    const file = "src/lib/catalog/restricted.ts";
    const code = readFileSync(path.join(root, file), "utf8");
    expect(specifiers(file)).not.toContain("next/cache");
    expect(code).not.toMatch(/unstable_cache|["']use cache/);
  });

  it("lets only the dynamic restricted block import restricted.ts", () => {
    const importers = sourceFiles(path.join(root, "src")).filter((file) =>
      specifiers(file).some((spec) =>
        RESTRICTED_MODULE.test(resolved(file, spec)),
      ),
    );
    expect(
      importers.filter((file) => !RESTRICTED_IMPORTERS.includes(file)),
    ).toEqual([]);
  });

  it("has no barrel that could re-export the restricted reader", () => {
    expect(catalogFiles.some((file) => /\/index\.[jt]sx?$/.test(file))).toBe(
      false,
    );
  });
});
