// Static guard for ADR 0073 (QA gate A M-1, extended to every admin service
// before the Phase 5 exit), on the TypeScript AST (not text): every exported
// function in the admin service modules (src/lib/admin/** and the import
// service entry) takes an AdminActor FIRST and checks it from the database
// as its first statement, unless it is a listed building block or pure
// helper. The unguarded building blocks are imported only by the services
// that guard them.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/* Modules with no service of their own: the check itself and the result type. */
const NOT_SERVICES = new Set([
  "src/lib/admin/actor.ts",
  "src/lib/admin/write-result.ts",
]);

const MODULES = [
  ...readdirSync(join(ROOT, "src/lib/admin"))
    .filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name))
    .map((name) => `src/lib/admin/${name}`)
    .filter((file) => !NOT_SERVICES.has(file)),
  // The bulk import's service entry (writes products, audits).
  "src/lib/import/index.ts",
];

/*
 * Exported functions that are NOT services, as "<module file>:<name>", with
 * the reason. Every other exported function in MODULES must take the actor
 * first and check it.
 */
const EXEMPT: Record<string, string> = {
  // customers.ts building blocks, reached only from access-requests.ts
  // (see the import test below). createCustomerAccount takes the actor and
  // is checked by Better Auth's own admin check (createUser with its headers).
  "customers.ts:findAccountByEmail": "building block (access-requests.ts only)",
  "customers.ts:issueInvite": "building block (access-requests.ts only)",
  "customers.ts:createCustomerAccount":
    "building block, Better Auth checks the actor",
  "customers.ts:applyAccess": "building block (access-requests.ts only)",
  "customers.ts:notifyAccessExtended":
    "building block (access-requests.ts only)",
  // Pure helpers: no database, no storage, no actor.
  "customers.ts:accessGrew": "pure",
  "customers.ts:inviteRefusalMessage": "pure",
  "customers.ts:escapeRegex": "pure",
  "customers.ts:customerStatusFilter": "pure (builds a filter object)",
  "customers.ts:generateTemporaryPassword": "pure (random string)",
  "products.ts:expectedVersion": "pure",
  "products.ts:tagsFor": "pure",
  "uploads.ts:badFormatMessage": "pure",
  // Reads only the public column-visibility setting; the import planner
  // uses it to drop restricted filter numbers.
  "products.ts:withoutRestrictedFilters":
    "public-setting filter, no admin data",
  // Building block of the image services (areas, categories, product
  // images), each of which checks the actor first.
  "uploads.ts:verifyUploadedImage": "building block (image services only)",
};

const exemptKey = (file: string, name: string) =>
  `${file.slice(file.lastIndexOf("/") + 1)}:${name}`;

/* Building blocks that take the actor but are checked elsewhere. */
const ACTOR_WITHOUT_CHECK = new Set(["customers.ts:createCustomerAccount"]);

const GUARD =
  /^(const refused = await refuseUnlessAdmin\(actor, "[\w-]+"\);|await assertAdminActor\(actor\);)$/;

/* Re-exported values the modules may pass through (constants / pure). */
const ALLOWED_REEXPORTS = new Set([
  "MAGNETIC_TRACK_SLUG",
  "FILTER_KEY_BY_SPEC",
  "COMMIT_ERRORS",
  "batchCount",
]);

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

/* `(x)`, `x as T`, `x satisfies T`, `x!` → x. */
function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

interface ExportedFunction {
  file: string;
  name: string;
  /** Positions of parameters typed AdminActor. */
  actorParams: number[];
  firstStatement: string;
  secondStatement: string;
}

/* Exported function declarations AND exported `const x = (…) =>` ones. */
function exportedFunctions(file: string): ExportedFunction[] {
  const sf = parse(file);
  const toExportedFunction = (
    name: string,
    fn: ts.SignatureDeclarationBase & { body?: ts.ConciseBody },
  ): ExportedFunction => ({
    file,
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
    // `export default …` and exported classes would slip past the checks
    // below: refuse them outright.
    if (ts.isExportAssignment(statement)) {
      throw new Error(`${file}: export default is not allowed here`);
    }
    if (!isExported(statement)) return [];
    if (ts.isClassDeclaration(statement)) {
      throw new Error(`${file}: exported class is not allowed here`);
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      return [toExportedFunction(statement.name.text, statement)];
    }
    if (ts.isVariableStatement(statement)) {
      return statement.declarationList.declarations.flatMap((d) => {
        const init = d.initializer && unwrap(d.initializer);
        return ts.isIdentifier(d.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          ? [toExportedFunction(d.name.text, init)]
          : [];
        // Any other value (a constant, a Zod schema, or a function made by
        // a wrapper such as cache(…)) is checked at runtime below.
      });
    }
    return [];
  });
}

/* Value names a module passes through with `export { … }` / `export *`. */
function reexportedValues(file: string): string[] {
  const sf = parse(file);
  return sf.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) return [];
    const clause = statement.exportClause;
    if (!clause) return ["*"];
    if (ts.isNamespaceExport(clause)) return [`* as ${clause.name.text}`];
    return clause.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text);
  });
}

describe("admin services check the actor first (ADR 0073)", () => {
  const all = MODULES.flatMap(exportedFunctions);
  const services = all.filter(
    (fn) => !Object.hasOwn(EXEMPT, exemptKey(fn.file, fn.name)),
  );

  it("covers every admin service module", () => {
    expect(MODULES.sort()).toEqual(
      [
        "src/lib/admin/access-requests.ts",
        "src/lib/admin/areas.ts",
        "src/lib/admin/categories.ts",
        "src/lib/admin/customers.ts",
        "src/lib/admin/dashboard.ts",
        "src/lib/admin/datasheets.ts",
        "src/lib/admin/product-images.ts",
        "src/lib/admin/products.ts",
        "src/lib/admin/settings.ts",
        "src/lib/admin/uploads.ts",
        "src/lib/import/index.ts",
      ].sort(),
    );
  });

  it("finds the services (the parser works; a new export must be listed)", () => {
    expect(services.map((s) => s.name).sort()).toEqual(
      [
        // access-requests.ts
        "listAccessRequests",
        "getAccessRequest",
        "approveAccessRequest",
        "rejectAccessRequest",
        "createManualAccessRequest",
        "deleteAccessRequest",
        // customers.ts
        "listCustomers",
        "getCustomer",
        "getCustomerCounts",
        "createCustomer",
        "updateCustomerProfile",
        "setCustomerAccess",
        "endCustomerAccess",
        "banCustomer",
        "unbanCustomer",
        "revokeCustomerSessions",
        "sendCustomerResetLink",
        "setTemporaryPassword",
        "regenerateInvite",
        // areas.ts
        "listAreas",
        "getAreaForEdit",
        "createArea",
        "updateArea",
        "setAreaImage",
        "moveArea",
        "deleteArea",
        // categories.ts
        "listCategoryTree",
        "getCategoryForEdit",
        "createCategory",
        "updateCategory",
        "moveCategory",
        "deleteCategory",
        "signCategoryImageUpload",
        "setCategoryImage",
        // dashboard.ts
        "getCounts",
        // datasheets.ts
        "listDatasheets",
        "presignDatasheetUpload",
        "finalizeDatasheet",
        "renameDatasheet",
        "deleteDatasheet",
        // product-images.ts
        "saveProductImages",
        // products.ts
        "listProducts",
        "getProductForEdit",
        "createDraft",
        "updateProduct",
        "publishProduct",
        "unpublishProduct",
        "deleteProduct",
        // settings.ts
        "getAdminSettings",
        "saveColumnVisibility",
        "saveWhatsappNumber",
        "saveCompanyEmail",
        // uploads.ts
        "signCloudinaryUpload",
        // import/index.ts
        "presignImport",
        "previewImport",
        "commitImportBatch",
        "finishImport",
      ].sort(),
    );
  });

  it("every exemption names a real export (no stale entries)", () => {
    const keys = new Set(all.map((fn) => exemptKey(fn.file, fn.name)));
    for (const key of Object.keys(EXEMPT)) {
      expect(keys.has(key), key).toBe(true);
    }
  });

  it("takes the actor as its one and only first parameter", () => {
    for (const { file, name, actorParams } of services) {
      expect(actorParams, `${file} ${name}`).toEqual([0]);
    }
    for (const key of ACTOR_WITHOUT_CHECK) {
      const fn = all.find((f) => exemptKey(f.file, f.name) === key);
      expect(fn?.actorParams, key).toEqual([0]);
    }
  });

  it("checks it as the very first statement", () => {
    for (const { file, name, firstStatement, secondStatement } of services) {
      expect(firstStatement, `${file} ${name}`).toMatch(GUARD);
      // refuseUnlessAdmin() returns the refusal: it must be returned at once.
      if (firstStatement.startsWith("const refused")) {
        expect(secondStatement, `${file} ${name}`).toBe(
          "if (refused) return refused;",
        );
      }
    }
  });

  it("exports no function the parser did not see (no wrapper-made services)", async () => {
    for (const file of MODULES) {
      const seen = new Set(
        all.filter((fn) => fn.file === file).map((fn) => fn.name),
      );
      const specifier = `@/${file.replace(/^src\//, "").replace(/\.ts$/, "")}`;
      const loaded: Record<string, unknown> = await import(specifier);
      for (const [name, value] of Object.entries(loaded)) {
        if (typeof value !== "function" || ALLOWED_REEXPORTS.has(name)) {
          continue;
        }
        expect(seen.has(name), `${file} exports function ${name}`).toBe(true);
      }
    }
  }, 60_000);

  it("passes through no function from elsewhere (re-exports are constants)", () => {
    for (const file of MODULES) {
      for (const name of reexportedValues(file)) {
        expect(ALLOWED_REEXPORTS.has(name), `${file} re-exports ${name}`).toBe(
          true,
        );
      }
    }
  });
});

describe("unguarded building blocks stay inside the services that guard them", () => {
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

  interface BlockRule {
    /** Matches the module specifier of the module holding the blocks. */
    module: RegExp;
    names: ReadonlySet<string>;
    /** The only files that may reach them. */
    importers: string[];
  }

  const RULES: Record<string, BlockRule> = {
    customers: {
      module: /(^|\/)admin\/customers$|^\.\/customers$/,
      names: new Set([
        "createCustomerAccount",
        "issueInvite",
        "applyAccess",
        "notifyAccessExtended",
        "findAccountByEmail",
      ]),
      importers: ["src/lib/admin/access-requests.ts"],
    },
    uploads: {
      module: /(^|\/)admin\/uploads$|^\.\/uploads$/,
      names: new Set(["verifyUploadedImage"]),
      importers: [
        "src/lib/admin/areas.ts",
        "src/lib/admin/categories.ts",
        "src/lib/admin/product-images.ts",
      ],
    },
    importCommit: {
      module: /(^|\/)import\/commit$|^\.\/commit$/,
      names: new Set(["commitPlanBatch"]),
      importers: ["src/lib/import/index.ts"],
    },
  };

  /*
   * True when the file reaches one of the rule's blocks: a named import or
   * re-export of one, a default/namespace import, `export *`, or a dynamic
   * import() of the module.
   */
  function reaches(sf: ts.SourceFile, rule: BlockRule): boolean {
    const fromModule = (specifier: ts.Expression | undefined) =>
      specifier !== undefined &&
      ts.isStringLiteral(specifier) &&
      rule.module.test(specifier.text);
    const named = (elements: readonly ts.ImportOrExportSpecifier[]) =>
      elements.some((e) =>
        rule.names.has((e.propertyName ?? e.name).getText(sf)),
      );
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isImportDeclaration(node) && fromModule(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        found = !bindings
          ? node.importClause?.name !== undefined
          : ts.isNamespaceImport(bindings) || named(bindings.elements);
      } else if (
        ts.isExportDeclaration(node) &&
        fromModule(node.moduleSpecifier)
      ) {
        const clause = node.exportClause;
        found =
          !clause || ts.isNamespaceExport(clause) || named(clause.elements);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        fromModule(node.arguments[0])
      ) {
        found = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  const files = ["src", "scripts"]
    .flatMap((dir) => sourceFiles(join(ROOT, dir)))
    .map((path) => relative(ROOT, path).split(sep).join("/"));

  it.each(Object.entries(RULES))(
    "%s: only the guarding services reach the blocks",
    (_name, rule) => {
      const importers = files.filter((file) => reaches(parse(file), rule));
      expect(importers.sort()).toEqual([...rule.importers].sort());
    },
  );

  const sampleReaches = (text: string) =>
    reaches(
      ts.createSourceFile("sample.ts", text, ts.ScriptTarget.Latest, true),
      RULES.customers as BlockRule,
    );

  it("self-test: re-exports, export * and import() are caught", () => {
    for (const sample of [
      'export { applyAccess } from "./customers";',
      'export * from "@/lib/admin/customers";',
      'export * as c from "@/lib/admin/customers";',
      'const m = await import("@/lib/admin/customers");',
      'import * as c from "@/lib/admin/customers";',
      'import { issueInvite as x } from "@/lib/admin/customers";',
      'import { findAccountByEmail } from "@/lib/admin/customers";',
    ]) {
      expect(sampleReaches(sample), sample).toBe(true);
    }
    expect(
      sampleReaches('import { CUSTOMERS_ONLY } from "@/lib/admin/customers";'),
    ).toBe(false);
  });
});
