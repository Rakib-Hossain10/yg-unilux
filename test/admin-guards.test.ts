// Static admin-guard checks (CLAUDE.md rule 3, ADR 0024, 0029): every admin
// page.tsx and layout.tsx starts with `await requireAdmin();` as statement one.
// Their generateMetadata/generateViewport must start with it too. Later tasks
// add their Server Action checks below, reusing the helpers.

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
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return functionBody(code, i);
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
    expect(files).toContain("src/app/admin/page.tsx");
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
