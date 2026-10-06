// Tests for the site chrome (header, footer, shell) and the 404/403 pages:
// the header's nav order and labels from CLAUDE.md, no language switcher,
// the skip link, and noindex on status pages.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ForbiddenPage, { metadata as forbiddenMeta } from "@/app/forbidden";
import NotFoundPage, { metadata as notFoundMeta } from "@/app/not-found";

import { FOOTER_NAV, MAIN_NAV } from "./nav-links";
import { SiteHeader } from "./site-header";
import { SiteShell } from "./site-shell";

const header = renderToStaticMarkup(SiteHeader());

describe("SiteHeader", () => {
  it("lists the five main sections in the agreed order", () => {
    expect(MAIN_NAV.map((item) => item.label)).toEqual([
      "Product",
      "Services",
      "OEM/ODM",
      "R&D",
      "About us",
    ]);
    for (const item of MAIN_NAV)
      expect(header).toContain(`href="${item.href}"`);
  });

  it("has named search, account and menu controls", () => {
    expect(header).toContain('aria-label="Search"');
    expect(header).toContain('aria-label="Account"');
    expect(header).toContain('aria-label="Menu"');
  });

  it("has no language switcher (English only)", () => {
    expect(header.toLowerCase()).not.toMatch(/language|locale|中文/);
  });
});

describe("SiteShell", () => {
  it("starts with a skip link pointing at the main content", () => {
    const html = renderToStaticMarkup(SiteShell({ children: "Body" }));
    expect(html.indexOf('href="#content"')).toBeLessThan(
      html.indexOf("<header"),
    );
    expect(html).toContain('<main id="content"');
    for (const column of FOOTER_NAV) {
      for (const link of column.links)
        expect(html).toContain(`href="${link.href}"`);
    }
  });
});

describe("status pages", () => {
  it("404 and 403 render inside the shell and are never indexed", () => {
    const notFound = renderToStaticMarkup(NotFoundPage());
    const forbidden = renderToStaticMarkup(ForbiddenPage());
    expect(notFound).toContain("Page not found");
    expect(forbidden).toContain("No access");
    for (const html of [notFound, forbidden]) expect(html).toContain("<header");
    expect(notFoundMeta.robots).toEqual({ index: false });
    expect(forbiddenMeta.robots).toEqual({ index: false });
  });

  it("the 403 page doesn't say which rule failed", () => {
    const forbidden = renderToStaticMarkup(ForbiddenPage()).toLowerCase();
    expect(forbidden).not.toMatch(/banned|expired|password|admin/);
  });
});
