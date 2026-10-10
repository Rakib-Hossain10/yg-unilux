// Static guard for QA gate A M-1, on the TypeScript AST (not text): every
// exported function in the P3 admin modules that takes an AdminActor takes
// it FIRST and checks it from the database as its first statement, and the
// unguarded building blocks (no actor check of their own) are imported only
// by those two modules.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MODULES = [
  "src/lib/admin/customers.ts",
  "src/lib/admin/access-requests.ts",
];

/*
 * Building blocks that run with no actor check: createCustomerAccount is
 * guarded by Better Auth's own admin check (createUser with the actor's
 * headers); the rest take no actor at all.
 */
const BUILDING_BLOCKS = new Set([
  "createCustomerAccount",
  "issueInvite",
  "applyAccess",
  "notifyAccessExtended",
]);

const GUARD =
  /^(const refused = await refuseUnlessAdmin\(actor, "[\w-]+"\);|await assertAdminActor\(actor\);)$/;

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(join(ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );

interface ExportedFunction {
  name: string;
  /** Positions of parameters typed AdminActor. */
  actorParams: number[];
  firstStatement: string;
  secondStatement: string;
}

/* Exported function declarations AND exported `const x = (…) =>` ones. */
function exportedFunctions(sf: ts.SourceFile): ExportedFunction[] {
  const toExportedFunction = (
    name: string,
    fn: ts.SignatureDeclarationBase & { body?: ts.ConciseBody },
  ): ExportedFunction => ({
    name,
    actorParams: fn.parameters.flatMap((p, i) =>
      p.type?.getText(sf) === "AdminActor" ? [i] : [],
    ),
    firstStatement:
      fn.body && ts.isBlock(fn.body)
        ? (fn.body.statements[0]?.getText(sf) ?? "")
        : (fn.body?.getText(sf) ?? ""),
    secondStatement:
      fn.body && ts.isBlock(fn.body)
        ? (fn.body.statements[1]?.getText(sf) ?? "")
        : "",
  });
  return sf.statements.flatMap((statement) => {
    if (!isExported(statement)) return [];
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      return [toExportedFunction(statement.name.text, statement)];
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((d) =>
        ts.isIdentifier(d.name) &&
        d.initializer &&
        (ts.isArrowFunction(d.initializer) ||
          ts.isFunctionExpression(d.initializer))
          ? [toExportedFunction(d.name.text, d.initializer)]
          : [],
      );
    }
    return [];
  });
}

describe("admin services check the actor first (QA M-1)", () => {
  const services = MODULES.flatMap((file) =>
    exportedFunctions(parse(file)).filter((fn) => fn.actorParams.length > 0),
  );

  it("finds the services (the parser works)", () => {
    expect(services.map((s) => s.name).sort()).toEqual(
      [
        // reads
        "listCustomers",
        "getCustomer",
        "getCustomerCounts",
        "listAccessRequests",
        "getAccessRequest",
        // writes
        "createCustomer",
        "updateCustomerProfile",
        "setCustomerAccess",
        "banCustomer",
        "unbanCustomer",
        "revokeCustomerSessions",
        "sendCustomerResetLink",
        "setTemporaryPassword",
        "regenerateInvite",
        "approveAccessRequest",
        "rejectAccessRequest",
        "createManualAccessRequest",
        "deleteAccessRequest",
        // building block, checked by Better Auth
        "createCustomerAccount",
      ].sort(),
    );
  });

  it("takes the actor as its one and only first parameter", () => {
    for (const { name, actorParams } of services) {
      expect(actorParams, name).toEqual([0]);
    }
  });

  it("checks it as the very first statement", () => {
    for (const { name, firstStatement, secondStatement } of services) {
      if (BUILDING_BLOCKS.has(name)) continue;
      expect(firstStatement, name).toMatch(GUARD);
      // refuseUnlessAdmin() returns the refusal: it must be returned at once.
      if (firstStatement.startsWith("const refused")) {
        expect(secondStatement, name).toBe("if (refused) return refused;");
      }
    }
  });
});

describe("unguarded building blocks stay inside the admin services", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|mts)$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name)
        ? [path]
        : [];
    });
  }

  const fromCustomers = (specifier: ts.Expression | undefined) =>
    specifier !== undefined &&
    ts.isStringLiteral(specifier) &&
    /(^|\/)admin\/customers$|^\.\/customers$/.test(specifier.text);

  /*
   * Files that reach a building block: a named import or re-export of one,
   * a default/namespace import, `export *`, or a dynamic import() of
   * customers.ts.
   */
  function reachesBuildingBlock(sf: ts.SourceFile): boolean {
    const named = (elements: readonly ts.ImportOrExportSpecifier[]) =>
      elements.some((e) =>
        BUILDING_BLOCKS.has((e.propertyName ?? e.name).getText(sf)),
      );
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isImportDeclaration(node) && fromCustomers(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        found = !bindings
          ? node.importClause?.name !== undefined
          : ts.isNamespaceImport(bindings) || named(bindings.elements);
      } else if (
        ts.isExportDeclaration(node) &&
        fromCustomers(node.moduleSpecifier)
      ) {
        const clause = node.exportClause;
        found =
          !clause || ts.isNamespaceExport(clause) || named(clause.elements);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        fromCustomers(node.arguments[0])
      ) {
        found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  const sampleReaches = (text: string) =>
    reachesBuildingBlock(
      ts.createSourceFile("sample.ts", text, ts.ScriptTarget.Latest, true),
    );

  it("only access-requests.ts reaches them in customers.ts", () => {
    const importers = ["src", "scripts"]
      .flatMap((dir) => sourceFiles(join(ROOT, dir)))
      .filter((path) =>
        reachesBuildingBlock(parse(relative(ROOT, path).split(sep).join("/"))),
      )
      .map((path) => relative(ROOT, path).split(sep).join("/"));
    expect(importers).toEqual(["src/lib/admin/access-requests.ts"]);
  });

  it("self-test: re-exports, export * and import() are caught", () => {
    for (const sample of [
      'export { applyAccess } from "./customers";',
      'export * from "@/lib/admin/customers";',
      'export * as c from "@/lib/admin/customers";',
      'const m = await import("@/lib/admin/customers");',
      'import * as c from "@/lib/admin/customers";',
      'import { issueInvite as x } from "@/lib/admin/customers";',
    ]) {
      expect(sampleReaches(sample), sample).toBe(true);
    }
    expect(
      sampleReaches('import { CUSTOMERS_ONLY } from "@/lib/admin/customers";'),
    ).toBe(false);
  });
});
