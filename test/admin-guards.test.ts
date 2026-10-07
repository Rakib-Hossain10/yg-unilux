// Static admin-guard checks (CLAUDE.md rule 3, ADR 0024, 0029): every admin
// page.tsx and layout.tsx starts with `await requireAdmin();` as statement one.
// Their generateMetadata/generateViewport must start with it too, and so must
// every exported Server Action in an admin actions.ts (ADR 0035).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_DIR = path.join(root, "src", "app", "admin");

// ---------------------------------------------------------------------------
// Helpers (shared with the Server Action checks)
// ---------------------------------------------------------------------------

/** Every file under src/app/admin whose base name matches, repo-relative. */
function adminFiles(match: (base: string) => boolean): string[] {
  return readdirSync(ADMIN_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && match(entry.name))
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .replaceAll("\\", "/"),
    )
    .sort();
}

function readSource(file: string): string {
  return readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
}

/*
 * Source with comments and string/template contents blanked out, so a
 * commented-out `await requireAdmin()` or one inside a string never counts.
 * Lengths are kept, so indexes still line up with the original text.
 */
function stripCommentsAndStrings(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    (match) => {
      const quote = match[0];
      if (quote === '"' || quote === "'" || quote === "`") {
        return quote + " ".repeat(match.length - 2) + quote;
      }
      return match.replace(/[^\n]/g, " ");
    },
  );
}

/**
 * The body of the function whose parameter list closes at `start`, found by
 * brace matching on stripped source. A return type such as
 * `Promise<{ title: string }>` is skipped: the body is the first `{` outside
 * angle brackets (an async function's return type is always `Promise<…>`).
 */
function functionBody(code: string, start: number): string | null {
  let open = -1;
  let angle = 0;
  for (let i = start; i < code.length; i++) {
    const ch = code[i];
    if (ch === "<") angle++;
    else if (ch === ">" && code[i - 1] !== "=") angle--;
    else if (ch === "{" && angle === 0) {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open + 1, i);
  }
  return null;
}

/*
 * The default-exported component's body, or null. Only the
 * `export default async function Name(...) {` form is accepted: an arrow or
 * a separately exported identifier would hide the guard from this check.
 * The parameter list is skipped by matching parentheses, so destructured
 * props with braces don't confuse the body search.
 */
function defaultExportBody(code: string): string | null {
  return asyncFunctionBody(
    code,
    /export\s+default\s+async\s+function\s+\w*\s*\(/,
  );
}

/* Body of the first async function whose header (ending in "(") matches. */
function asyncFunctionBody(code: string, header: RegExp): string | null {
  const match = header.exec(code);
  if (!match) return null;
  return bodyAfterParams(code, match.index + match[0].length - 1);
}

/*
 * The body of a function whose parameter list opens at `paren`: skips the
 * parameters by matching parentheses, then finds the body.
 */
function bodyAfterParams(code: string, paren: number): string | null {
  return paramsAndBody(code, paren)?.body ?? null;
}

/* The parameter list (without its parentheses) and the body. */
function paramsAndBody(
  code: string,
  paren: number,
): { params: string; body: string | null } | null {
  let depth = 0;
  for (let i = paren; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) {
      return { params: code.slice(paren + 1, i), body: functionBody(code, i) };
    }
  }
  return null;
}

/*
 * Statement one of the body must be exactly `await requireAdmin();`, bare or
 * assigned (`const viewer = …`, `const { user } = …`). Anchoring to the start
 * rejects anything before it (an early return, a sync call that starts a
 * query, a `try {`), and requiring `)` then `;` rejects a chained
 * `.catch(...)` that would swallow the redirect/403 (ADR 0024).
 */
const GUARD_FIRST =
  /^\s*(?:(?:const|let)\s+(?:\w+|\{[^}]*\})\s*=\s*)?await\s+requireAdmin\s*\(\s*\)\s*;/;

/** Source with comments removed but strings kept (for imports, directives). */
function stripComments(source: string): string {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    (match) => (match.startsWith("/") ? "" : match),
  );
}

/** Why a page/layout source fails the guard rule, or null when it passes. */
function guardProblem(source: string): string | null {
  const withStrings = stripComments(source);
  if (/^\s*["']use client["']/.test(withStrings)) {
    return "is a client component (requireAdmin() needs the server)";
  }
  if (
    !/import\s*\{[^}]*\brequireAdmin\b[^}]*\}\s*from\s*["']@\/lib\/permissions["']/.test(
      withStrings,
    )
  ) {
    return "does not import requireAdmin from @/lib/permissions";
  }
  const code = stripCommentsAndStrings(source);
  const body = defaultExportBody(code);
  if (body === null) {
    return "has no `export default async function` component";
  }
  if (!GUARD_FIRST.test(body)) {
    return "does not start with `await requireAdmin();`";
  }
  return metadataProblem(code);
}

/*
 * generateMetadata/generateViewport run even when the layout's guard throws
 * forbidden(): e2e showed a page's metadata in a customer's 403 payload. One
 * that reads data (a product name in the title) would leak it, so each must
 * be an `export async function` that starts with the guard as well. Static
 * `export const metadata` objects hold constants and are fine.
 * generateStaticParams runs at build time with no request, so it can't check
 * a session and is not allowed in admin routes at all.
 */
function metadataProblem(code: string): string | null {
  if (/\bgenerateStaticParams\b/.test(code)) {
    return "uses generateStaticParams (admin routes are per-request only)";
  }
  for (const name of ["generateMetadata", "generateViewport"]) {
    if (!new RegExp(`\\b${name}\\b`).test(code)) continue;
    const body = asyncFunctionBody(
      code,
      new RegExp(`export\\s+async\\s+function\\s+${name}\\s*\\(`),
    );
    if (body === null) return `${name} is not an \`export async function\``;
    if (!GUARD_FIRST.test(body)) {
      return `${name} does not start with \`await requireAdmin();\``;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pages and layouts
// ---------------------------------------------------------------------------

/*
 * Server files that render a route's content. Each must start with the guard:
 * Next renders a segment's layout, template, page and slot defaults in
 * parallel, so one guard does not cover the others (ADR 0029).
 * loading/error/not-found/forbidden render no data and need no guard.
 */
const RENDERING_FILE = /^(page|layout|template|default)\.tsx$/;

/*
 * Every Next route file name in any extension. Route handlers (`route.*`) and
 * metadata routes (opengraph-image, icon, sitemap, ...) are listed so adding
 * one fails until a check here covers it; other extensions would slip past
 * the .tsx parser above.
 */
const ANY_ROUTE_FILE =
  /^(page|layout|template|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\d*\.(js|jsx|ts|tsx|mdx)$/;

describe("admin pages and layouts call requireAdmin() first", () => {
  const files = adminFiles((base) => RENDERING_FILE.test(base));

  it("finds the admin layout and dashboard page", () => {
    expect(files).toContain("src/app/admin/layout.tsx");
    expect(files).toContain("src/app/admin/(dashboard)/page.tsx");
  });

  it("has no admin route file that this suite does not check", () => {
    expect(
      adminFiles(
        (base) => ANY_ROUTE_FILE.test(base) && !RENDERING_FILE.test(base),
      ),
    ).toEqual([]);
  });

  it.each(files)("%s", (file) => {
    expect(guardProblem(readSource(file))).toBeNull();
  });
});

describe("the guard check itself", () => {
  const ok = `import { requireAdmin } from "@/lib/permissions";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireAdmin();
  const { id } = await params;
  return null;
}`;

  it("accepts a page whose first statement awaits requireAdmin()", () => {
    expect(guardProblem(ok)).toBeNull();
  });

  it.each([
    "await requireAdmin();",
    "const { user } = await requireAdmin();",
    "let viewer = await requireAdmin();",
  ])("accepts the form: %s", (statement) => {
    const source = `import { getViewer, requireAdmin } from "@/lib/permissions";
export default async function Layout({ children }: { children: unknown }) {
  ${statement}
  return children;
}`;
    expect(guardProblem(source)).toBeNull();
  });

  it("accepts an object-literal return type before the body", () => {
    const source = `import { requireAdmin } from "@/lib/permissions";
export default async function Page(): Promise<{ type: string } | null> {
  await requireAdmin();
  return null;
}`;
    expect(guardProblem(source)).toBeNull();
  });

  it("accepts a generateMetadata that starts with the guard", () => {
    const source = `import { requireAdmin } from "@/lib/permissions";
export async function generateMetadata({ params }: Props) {
  await requireAdmin();
  return { title: (await params).id };
}
export default async function Page() { await requireAdmin(); }`;
    expect(guardProblem(source)).toBeNull();
  });

  it.each([
    [
      "missing call",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() { return null; }`,
    ],
    [
      "another await first",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  const data = await load();
  await requireAdmin();
}`,
    ],
    [
      "commented-out call",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  // await requireAdmin();
  const data = await load();
}`,
    ],
    [
      "call not awaited",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  requireAdmin();
  return null;
}`,
    ],
    [
      "inside try",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  try { await requireAdmin(); } catch {}
}`,
    ],
    [
      "arrow default export",
      `import { requireAdmin } from "@/lib/permissions";
const Page = async () => { await requireAdmin(); };
export default Page;`,
    ],
    [
      "early return before the guard",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  if (flag) return null;
  await requireAdmin();
}`,
    ],
    [
      "sync call before the guard",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  const rows = loadCases();
  await requireAdmin();
}`,
    ],
    [
      ".catch chained on the guard",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  await requireAdmin().catch(() => null);
}`,
    ],
    [
      ".catch on the next line",
      `import { requireAdmin } from "@/lib/permissions";
export default async function Page() {
  await requireAdmin()
    .catch(() => null);
}`,
    ],
    [
      "commented-out import",
      `// import { requireAdmin } from "@/lib/permissions";
import { requireAdmin } from "./fake";
export default async function Page() { await requireAdmin(); }`,
    ],
    [
      "client component after a header comment",
      `// Some admin page.
"use client";
import { requireAdmin } from "@/lib/permissions";
export default async function Page() { await requireAdmin(); }`,
    ],
    [
      "generateMetadata without the guard",
      `import { requireAdmin } from "@/lib/permissions";
export async function generateMetadata() {
  const product = await loadProduct();
  return { title: product.name };
}
export default async function Page() { await requireAdmin(); }`,
    ],
    [
      "generateMetadata as an arrow",
      `import { requireAdmin } from "@/lib/permissions";
export const generateMetadata = async () => ({ title: await name() });
export default async function Page() { await requireAdmin(); }`,
    ],
    [
      "generateStaticParams",
      `import { requireAdmin } from "@/lib/permissions";
export async function generateStaticParams() { return []; }
export default async function Page() { await requireAdmin(); }`,
    ],
    [
      "client component",
      `"use client";
import { requireAdmin } from "@/lib/permissions";
export default async function Page() { await requireAdmin(); }`,
    ],
    [
      "requireAdmin from elsewhere",
      `import { requireAdmin } from "./fake";
export default async function Page() { await requireAdmin(); }`,
    ],
  ])("rejects: %s", (_name, source) => {
    expect(guardProblem(source)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Server Actions (T5 on; ADR 0035)
// ---------------------------------------------------------------------------

/*
 * Admin Server Actions live only in `actions.ts` files under src/app/admin.
 * Each such file is a "use server" module whose every runtime export is an
 * `export async function` starting with `await requireAdmin();`. An action
 * is a public POST endpoint: hiding the button that calls it guards nothing.
 */
const ACTION_FILE = /^actions\.ts$/;

/* A "use server" directive at the top of a file or inside a function. */
const USE_SERVER = /["']use server["']/;

/** Why an actions.ts source fails the rules (empty when it passes). */
function actionProblems(source: string): string[] {
  const problems: string[] = [];
  const withStrings = stripComments(source);
  if (!/^\s*["']use server["']/.test(withStrings)) {
    problems.push('does not start with the "use server" directive');
  }
  if (
    !/import\s*\{[^}]*\brequireAdmin\b[^}]*\}\s*from\s*["']@\/lib\/permissions["']/.test(
      withStrings,
    )
  ) {
    problems.push("does not import requireAdmin from @/lib/permissions");
  }

  const code = stripCommentsAndStrings(source);
  // Catching the guard's redirect/403 would let the action run (ADR 0024).
  if (/\btry\s*\{/.test(code)) problems.push("uses try (wraps the guard)");
  if (/\.catch\s*\(/.test(code)) problems.push("uses .catch (wraps the guard)");

  // Every runtime export must be an async function the loop below checks.
  for (const match of code.matchAll(/\bexport\b\s*(\S+(?:\s+\S+)?)/g)) {
    const rest = match[1] ?? "";
    if (/^(type|interface)\b/.test(rest) || /^async\s+function$/.test(rest)) {
      continue;
    }
    problems.push(`has a non-function export: \`export ${rest}\``);
  }

  /*
   * Only the plain `name(` form is parsed. Any other shape (a type parameter
   * such as `name<T>(`) is counted but not matched, so it fails here instead
   * of slipping past the guard check below.
   */
  const declared = code.match(/\bexport\s+async\s+function\b/g)?.length ?? 0;
  const actions = [...code.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g)];
  if (actions.length === 0) problems.push("exports no action");
  if (declared !== actions.length) {
    problems.push("has an action this check cannot parse (write `name(`)");
  }
  /*
   * Every action must revalidate and write through a service. Audit entries
   * are written inside the services (ADR 0035): an action that calls none of
   * the names imported from "@/lib/admin/*" cannot have audited its write.
   * `revalidators` is the shared helper plus any local helper that calls it
   * (e.g. a writeResult() tail).
   */
  const revalidators = new Set(["revalidateCatalogInAction"]);
  for (const helper of code.matchAll(
    /(?:^|\n)(?:async\s+)?function\s+(\w+)\s*\(/g,
  )) {
    const at = (helper.index ?? 0) + helper[0].length - 1;
    if (
      /\brevalidateCatalogInAction\s*\(/.test(bodyAfterParams(code, at) ?? "")
    ) {
      revalidators.add(helper[1] ?? "");
    }
  }
  const services = new Set<string>();
  for (const imp of withStrings.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/admin\/(?!write-result)[\w-]+["']/g,
  )) {
    for (const name of (imp[1] ?? "").split(",")) {
      const clean = name.trim();
      if (clean !== "" && !/^type\s/.test(clean)) services.add(clean);
    }
  }
  for (const match of actions) {
    const parts = paramsAndBody(code, match.index + match[0].length - 1);
    // A default value runs when the action is called, before the guard.
    if (parts && /=(?!>)/.test(parts.params)) {
      problems.push(`${match[1]} has a default parameter value`);
    }
    if (!parts?.body || !GUARD_FIRST.test(parts.body)) {
      problems.push(
        `${match[1]} does not start with \`await requireAdmin();\``,
      );
    }
    if (parts?.body) {
      const body = parts.body;
      if (!callsAny(body, revalidators)) {
        problems.push(
          `${match[1]} does not revalidate (revalidateCatalogInAction)`,
        );
      }
      if (!callsAny(body, services)) {
        problems.push(
          `${match[1]} calls no admin service (the audit entry is written there)`,
        );
      }
    }
  }
  return problems;
}

/** True when the body calls one of the names, e.g. `name(`. */
function callsAny(body: string, names: Set<string>): boolean {
  return [...names].some((name) => new RegExp(`\\b${name}\\s*\\(`).test(body));
}

describe("admin Server Actions call requireAdmin() first", () => {
  const files = adminFiles((base) => ACTION_FILE.test(base));

  it("finds the categories actions", () => {
    expect(files).toContain("src/app/admin/categories/actions.ts");
  });

  it("finds the areas actions", () => {
    expect(files).toContain("src/app/admin/areas/actions.ts");
  });

  it("finds the products actions", () => {
    expect(files).toContain("src/app/admin/products/actions.ts");
  });

  it("finds the datasheets actions", () => {
    expect(files).toContain("src/app/admin/datasheets/actions.ts");
  });

  it("finds the settings actions", () => {
    expect(files).toContain("src/app/admin/settings/actions.ts");
  });

  it.each(files)("%s", (file) => {
    expect(actionProblems(readSource(file))).toEqual([]);
  });

  /*
   * An inline "use server" function in a page or component, or a
   * differently named file, would be an action this suite never checks.
   */
  it("has no Server Action outside an actions.ts file", () => {
    const dirs = [ADMIN_DIR, path.join(root, "src", "components", "admin")];
    const offenders = dirs.flatMap((dir) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
            // actions.ts is checked above, but only under src/app/admin.
            !(
              ACTION_FILE.test(entry.name) &&
              entry.parentPath.startsWith(ADMIN_DIR)
            ) &&
            !entry.name.endsWith(".test.ts"),
        )
        .map((entry) => path.join(entry.parentPath, entry.name))
        .filter((file) =>
          USE_SERVER.test(stripComments(readFileSync(file, "utf8"))),
        )
        .map((file) => path.relative(root, file).replaceAll("\\", "/")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the Server Action check itself", () => {
  const ok = `"use server";
// header
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";
import { save, move } from "@/lib/admin/things";
export type Result = { ok: boolean };
function helper(x: unknown) { return x; }
function tail(result: unknown) { revalidateCatalogInAction([]); return result; }
export async function saveAction(id: unknown, values: unknown): Promise<Result> {
  const viewer = await requireAdmin();
  const result = await save(viewer.user.id, { id, values });
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return helper(result);
  redirect("/admin");
}
export async function moveAction(id: unknown) {
  await requireAdmin();
  return tail(await move(id));
}`;

  it("accepts actions that each start with the guard", () => {
    expect(actionProblems(ok)).toEqual([]);
  });

  it("accepts a function-typed parameter (=> is not a default value)", () => {
    const source = `"use server";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";
import { save } from "@/lib/admin/things";
export async function a(pick: (id: string) => boolean) {
  await requireAdmin();
  revalidateCatalogInAction((await save()).tags);
}`;
    expect(actionProblems(source)).toEqual([]);
  });

  it("rejects an action that does not revalidate", () => {
    const source = `"use server";
import { requireAdmin } from "@/lib/permissions";
import { save } from "@/lib/admin/things";
export async function a() {
  await requireAdmin();
  await save();
}`;
    expect(actionProblems(source).join()).toMatch(/does not revalidate/);
  });

  it("rejects an action that calls no admin service", () => {
    const source = `"use server";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";
export async function a() {
  await requireAdmin();
  revalidateCatalogInAction([]);
}`;
    expect(actionProblems(source).join()).toMatch(/calls no admin service/);
  });

  it.each([
    ["no directive", ok.replace('"use server";', "")],
    [
      "directive after code",
      `import { requireAdmin } from "@/lib/permissions";
"use server";
export async function a() { await requireAdmin(); }`,
    ],
    [
      "requireAdmin from elsewhere",
      ok.replace('"@/lib/permissions"', '"./fake"'),
    ],
    [
      "one action without the guard",
      ok.replace(
        "  await requireAdmin();\n  return tail(await move(id));",
        "  return tail(await move(id));",
      ),
    ],
    [
      "guard after the service call",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export async function a(id: unknown) {
  await remove(id);
  await requireAdmin();
}`,
    ],
    [
      "guard inside try",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export async function a() {
  try { await requireAdmin(); } catch {}
}`,
    ],
    [
      ".catch on the guard",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export async function a() {
  await requireAdmin().catch(() => null);
}`,
    ],
    [
      "arrow export",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export const a = async () => { await save(); };`,
    ],
    [
      "re-export",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export { deleteEverything } from "./danger";
export async function a() { await requireAdmin(); }`,
    ],
    [
      "default export",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export default async function a() { await save(); }`,
    ],
    [
      "commented-out guard",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export async function a() {
  // await requireAdmin();
  await save();
}`,
    ],
    [
      "generic action without the guard",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export async function a() { await requireAdmin(); }
export async function purge<T>(ids: T) { await remove(ids); }`,
    ],
    [
      "default parameter that runs before the guard",
      `"use server";
import { requireAdmin } from "@/lib/permissions";
export async function a(id = purgeDrafts()) {
  await requireAdmin();
}`,
    ],
    [
      "no actions at all",
      `"use server";
import { requireAdmin } from "@/lib/permissions";`,
    ],
  ])("rejects: %s", (_name, source) => {
    expect(source).not.toBe(ok);
    expect(actionProblems(source)).not.toEqual([]);
  });
});
