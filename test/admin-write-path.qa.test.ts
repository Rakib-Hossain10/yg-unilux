// QA gate A (Phase 2): static checks on the admin write path that the guard
// suite does not make. Server Actions exist only in admin actions.ts files
// anywhere under src/, services stay server-only, and client files never
// import service code (Phase 2 plan, "ESLint"; ADR 0035).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(root, "src");

/* Every source file under src/, repo-relative with forward slashes. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) &&
        !/\.test\.(ts|tsx)$/.test(entry.name),
    )
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .replaceAll("\\", "/"),
    )
    .sort();
}

/* Source without comments (strings kept: directives are strings). */
function code(file: string): string {
  return readFileSync(path.join(root, file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
      (match) => (match.startsWith("/") ? "" : match),
    );
}

const files = sourceFiles();
const ACTIONS_FILE = /^src\/app\/admin\/(?:.+\/)?actions\.ts$/;

describe("Server Actions exist only in admin actions.ts files", () => {
  /*
   * A "use server" module turns every export into a public POST endpoint.
   * The admin services take the actor id as an argument, so one stray
   * directive in src/lib/admin would let anyone write as any admin id.
   */
  it("finds no 'use server' anywhere else under src/", () => {
    const offenders = files.filter(
      (file) =>
        !ACTIONS_FILE.test(file) && /["']use server["']/.test(code(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("still sees the known actions files", () => {
    expect(files.filter((file) => ACTIONS_FILE.test(file))).toEqual([
      "src/app/admin/areas/actions.ts",
      "src/app/admin/categories/actions.ts",
      "src/app/admin/products/actions.ts",
    ]);
  });
});

describe("admin services are server-only", () => {
  const services = files.filter((file) => file.startsWith("src/lib/admin/"));

  it("finds the services", () => {
    expect(services).toEqual(
      expect.arrayContaining([
        "src/lib/admin/areas.ts",
        "src/lib/admin/categories.ts",
        "src/lib/admin/dashboard.ts",
        "src/lib/admin/write-result.ts",
      ]),
    );
  });

  it.each(services)("%s imports server-only", (file) => {
    expect(code(file)).toMatch(/^\s*import\s+["']server-only["'];/m);
  });

  it.each(["src/lib/audit.ts", "src/lib/revalidate.ts"])(
    "%s imports server-only",
    (file) => {
      expect(code(file)).toMatch(/^\s*import\s+["']server-only["'];/m);
    },
  );
});

describe("client files never import admin service code", () => {
  const clientFiles = files.filter((file) =>
    /^\s*["']use client["']/.test(code(file)),
  );

  it("finds the admin client components", () => {
    expect(clientFiles).toEqual(
      expect.arrayContaining([
        "src/components/admin/category-form.tsx",
        "src/components/admin/category-tree.tsx",
        "src/components/admin/area-form.tsx",
        "src/components/admin/area-list.tsx",
      ]),
    );
  });

  /*
   * A value import of a service would either fail the build (server-only) or,
   * worse, bundle it. `import type` is erased and allowed. Modules that a
   * client file imports for values are checked one level deep too
   * (action-result.ts is imported by the forms and imports a type only).
   */
  const SERVER_MODULES =
    /from\s*["']@\/(?:lib\/admin\/|lib\/audit["']|lib\/revalidate["']|lib\/db["']|lib\/permissions["']|lib\/auth["']|lib\/env["']|models(?:\/|["']))/;

  function valueImports(source: string): string[] {
    return [
      ...source.matchAll(
        /^\s*import\s+(?!type\b)[^;]*?from\s*["'][^"']+["'];/gm,
      ),
    ].map((match) => match[0]);
  }

  it.each(clientFiles)("%s", (file) => {
    const direct = valueImports(code(file)).filter((line) =>
      SERVER_MODULES.test(line),
    );
    expect(direct).toEqual([]);
  });

  it("action-result.ts takes only a type from the services", () => {
    const source = code("src/components/admin/action-result.ts");
    expect(
      valueImports(source).filter((line) => SERVER_MODULES.test(line)),
    ).toEqual([]);
    expect(source).toMatch(
      /import\s+type\s*\{\s*ServiceErrors\s*\}\s*from\s*["']@\/lib\/admin\/write-result["']/,
    );
  });
});
