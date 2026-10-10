// Static guard for the datasheet download (rule 2, ADR 0071): the ONLY
// source file that may mint a presigned datasheet GET is the download route,
// which runs the access check, the limit and the log first. No other module
// may name `presignGet`, and no module may reach storage.ts through a
// namespace import, `export *`, `import()` or `require()` (which would let
// it call presignGet without naming it). A non-literal import()/require()
// counts too, since its target can't be checked.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  norm,
  resolveSpecifier,
  sourceFiles,
  SRC,
} from "./helpers/module-graph";

const STORAGE = norm(path.join(SRC, "lib", "storage.ts"));
const ROUTE = norm(path.join(SRC, "app/api/datasheet/[productId]/route.ts"));

const files = sourceFiles(SRC);

function resolvesToStorage(spec: string, from: string): boolean {
  const resolved = resolveSpecifier(spec, from);
  return resolved !== null && norm(resolved) === STORAGE;
}

/* Every way a file pulls in storage.ts without naming its exports. */
function wholeModuleUses(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      resolvesToStorage(node.moduleSpecifier.text, file) &&
      node.importClause?.namedBindings &&
      ts.isNamespaceImport(node.importClause.namedBindings)
    ) {
      found.push("import * as");
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      resolvesToStorage(node.moduleSpecifier.text, file) &&
      (!node.exportClause || ts.isNamespaceExport(node.exportClause))
    ) {
      found.push("export *");
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression) &&
      resolvesToStorage(node.moduleReference.expression.text, file)
    ) {
      found.push("import = require()");
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const [arg] = node.arguments;
      if (
        !arg ||
        !ts.isStringLiteral(arg) ||
        resolvesToStorage(arg.text, file)
      ) {
        found.push("import() or require()");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("presignGet guard (ADR 0071)", () => {
  it("finds the route and storage.ts (the guard is looking at real files)", () => {
    const names = files.map(norm);
    expect(names).toContain(ROUTE);
    expect(names).toContain(STORAGE);
    expect(readFileSync(ROUTE, "utf8")).toMatch(/\bpresignGet\b/);
  });

  it("only the download route names presignGet", () => {
    const offenders = files
      .filter((file) => ![STORAGE, ROUTE].includes(norm(file)))
      .filter((file) => /\bpresignGet\b/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it("no module takes storage.ts whole (namespace, export *, dynamic import)", () => {
    const offenders = files
      .filter((file) => norm(file) !== STORAGE)
      .flatMap((file) =>
        wholeModuleUses(file).map(
          (how) => `${path.relative(SRC, file)}: ${how}`,
        ),
      );
    expect(offenders).toEqual([]);
    // Parses every source file: slow under a full parallel run.
  }, 30_000);
});

describe("the guard itself catches each form (self-test)", () => {
  it.each([
    ['import * as s from "@/lib/storage";', "import * as"],
    ['export * from "@/lib/storage";', "export *"],
    ['export * as s from "@/lib/storage";', "export *"],
    ['const s = await import("@/lib/storage");', "import() or require()"],
    ['const s = require("@/lib/storage");', "import() or require()"],
    ['import s = require("@/lib/storage");', "import = require()"],
    ["const s = await import(name);", "import() or require()"],
  ])("%s", (code, expected) => {
    const dir = mkdtempSync(path.join(tmpdir(), "yg-presign-guard-"));
    const file = path.join(dir, "probe.ts");
    try {
      writeFileSync(file, `${code}\n`);
      expect(wholeModuleUses(file)).toEqual([expected]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a named import of other storage functions alone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "yg-presign-guard-"));
    const file = path.join(dir, "probe.ts");
    try {
      writeFileSync(file, 'import { presignPut } from "@/lib/storage";\n');
      expect(wholeModuleUses(file)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
