// Header and footer links prefetch exactly when the page behind them exists
// (Phase 4b Q8): a built page keeps next/link's default prefetch, a page not
// built yet opts out, or its prefetch would log a 404 on every page. The
// routes are read from src/app, so building a page fails this test until the
// flag is removed.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FOOTER_NAV, MAIN_NAV, type NavLink } from "./nav-links";

const APP = join(process.cwd(), "src", "app");

/** Route groups (folders in parentheses) plus the root. */
const roots = [
  APP,
  ...readdirSync(APP, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\(.+\)$/.test(entry.name))
    .map((entry) => join(APP, entry.name)),
];

/** True when a page under src/app answers this static path. */
function routeExists(href: string): boolean {
  const segments = href.split("/").filter(Boolean);
  return roots.some((root) => {
    const dir = join(root, ...segments);
    if (existsSync(join(dir, "page.tsx"))) return true;
    // An optional catch-all (`[[...x]]`) also answers the bare path.
    if (!existsSync(dir)) return false;
    return readdirSync(dir).some(
      (name) =>
        /^\[\[\.\.\..+\]\]$/.test(name) &&
        existsSync(join(dir, name, "page.tsx")),
    );
  });
}

const allLinks: readonly NavLink[] = [
  ...MAIN_NAV,
  ...FOOTER_NAV.flatMap((column) => column.links),
];

describe("nav link prefetch", () => {
  it("finds the pages that are built", () => {
    expect(routeExists("/products")).toBe(true);
    expect(routeExists("/areas")).toBe(true);
    expect(routeExists("/search")).toBe(true);
    expect(routeExists("/no-such-page")).toBe(false);
  });

  it.each(allLinks.map((link) => [link.href, link] as const))(
    "%s prefetches only when its page exists",
    (_href, link) => {
      if (routeExists(link.href)) expect(link.prefetch).toBeUndefined();
      else expect(link.prefetch).toBe(false);
    },
  );
});
