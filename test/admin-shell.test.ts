// Admin shell checks that need no browser: the admin error boundary never
// prints a server error message (only the digest), and the nav lists every
// module exactly once with a unique /admin link.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AdminError from "@/app/admin/error";
import { ADMIN_NAV } from "@/components/admin/admin-sections";

describe("admin error boundary", () => {
  const secret = "MongoServerError: auth failed for mongodb+srv://u:p@host";

  it("shows a fixed message and the digest, never the error text", () => {
    const error = Object.assign(new Error(secret), { digest: "4242424242" });
    const html = renderToStaticMarkup(
      createElement(AdminError, { error, retry: () => {} }),
    );
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    expect(html).toContain("4242424242");
    expect(html).not.toContain("MongoServerError");
    expect(html).not.toContain("mongodb+srv");
  });

  it("renders no reference line without a digest", () => {
    const html = renderToStaticMarkup(
      createElement(AdminError, { error: new Error(secret), retry: () => {} }),
    );
    expect(html).not.toContain("Reference");
    expect(html).not.toContain("MongoServerError");
  });
});

describe("admin nav", () => {
  it("lists the nine modules in order, each with a unique /admin link", () => {
    expect(ADMIN_NAV.map((s) => s.label)).toEqual([
      "Dashboard",
      "Products",
      "Categories",
      "Areas",
      "Datasheets",
      "Customers",
      "Access requests",
      "Settings",
      "Whistleblower",
    ]);
    const hrefs = ADMIN_NAV.map((s) => s.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) expect(href).toMatch(/^\/admin(\/[a-z-]+)?$/);
  });
});
