// Render and helper tests for the products UI without a browser: the table,
// pager and filters markup, the new-product form's labels and error mapping,
// the list URLs, and the stale-notice cleanup used by the move buttons (L-4).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The real action needs a session and a database; it never runs here.
vi.mock("@/app/admin/products/actions", () => ({
  createDraftAction: vi.fn(),
}));

import { urlWithoutNotice } from "./clear-notice";
import { categoryOptions } from "./product-category-options";
import { ProductFilters } from "./product-filters";
import {
  applyNewProductErrors,
  newProductSchema,
  ProductNewForm,
} from "./product-new-form";
import { productEditPath, productsListPath } from "./product-paths";
import {
  ProductsPager,
  ProductsTable,
  type ProductRow,
} from "./products-table";

const A = "65f0c0ffee0000000000000a";
const A1 = "65f0c0ffee00000000000a01";
const P = "65f0c0ffee000000000000ff";

const row: ProductRow = {
  id: P,
  name: "Arc <b>AR-013A</b>",
  slug: "arc-ar-013a",
  family: "Arc",
  modelCode: null,
  firstModelNo: "AR-013A1",
  mainCategoryName: "Spot Lights",
  variantCount: 2,
  status: "draft",
  updatedAt: "2026-10-06T12:00:00.000Z",
};

describe("ProductsTable", () => {
  const html = renderToStaticMarkup(
    createElement(ProductsTable, {
      rows: [
        row,
        { ...row, id: A, status: "published", mainCategoryName: null },
      ],
    }),
  );

  it("links each name to its edit page and escapes text", () => {
    expect(html).toContain(`href="/admin/products/${P}"`);
    expect(html).toContain("Arc &lt;b&gt;AR-013A&lt;/b&gt;");
    expect(html).not.toContain("<b>AR-013A</b>");
  });

  it("falls back to the first model no. and shows the family", () => {
    expect(html).toContain("AR-013A1");
    expect(html).toContain(">Arc<");
  });

  it("shows status badges, a missing category and a machine-readable date", () => {
    expect(html).toContain("Draft");
    expect(html).toContain("Published");
    expect(html).toContain("Missing category");
    expect(html).toContain('dateTime="2026-10-06T12:00:00.000Z"');
    expect(html).toContain("6 Oct 2026");
  });
});

describe("ProductsPager", () => {
  it("renders nothing for a single page", () => {
    expect(
      renderToStaticMarkup(
        createElement(ProductsPager, { query: {}, page: 1, pageCount: 1 }),
      ),
    ).toBe("");
  });

  it("keeps the filters in its links and disables the missing direction", () => {
    const html = renderToStaticMarkup(
      createElement(ProductsPager, {
        query: { q: "arc", status: "draft" },
        page: 1,
        pageCount: 3,
      }),
    );
    expect(html).toContain('aria-label="Product pages"');
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain(
      'href="/admin/products?q=arc&amp;status=draft&amp;page=2"',
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Previous/);
  });

  it("sends a page past the end back to the last page", () => {
    const html = renderToStaticMarkup(
      createElement(ProductsPager, { query: {}, page: 9, pageCount: 3 }),
    );
    expect(html).toContain('href="/admin/products?page=3"');
  });
});

describe("ProductFilters", () => {
  it("is a labelled GET search form", () => {
    const html = renderToStaticMarkup(
      createElement(ProductFilters, {
        values: { q: "arc", status: "all", category: "all" },
        categories: [{ id: A, label: "Spot Lights" }],
        filtered: true,
      }),
    );
    expect(html).toContain('role="search"');
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/admin/products"');
    for (const id of ["products-q", "products-status", "products-category"]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('value="arc"');
    expect(html).toContain("Clear");
  });
});

describe("productsListPath", () => {
  it("leaves out empty filters and page 1", () => {
    expect(productsListPath({})).toBe("/admin/products");
    expect(productsListPath({ q: "", page: 1 })).toBe("/admin/products");
  });

  it("encodes the search text", () => {
    expect(productsListPath({ q: "a&b c", category: A, page: 2 })).toBe(
      `/admin/products?q=a%26b+c&category=${A}&page=2`,
    );
  });

  it("builds the edit path", () => {
    expect(productEditPath(P)).toBe(`/admin/products/${P}`);
  });
});

describe("categoryOptions", () => {
  it("lists each main category followed by its subcategories", () => {
    expect(
      categoryOptions([
        {
          id: A,
          name: "Spot Lights",
          slug: "spot-lights",
          parentId: null,
          order: 0,
          description: null,
          children: [
            {
              id: A1,
              name: "Recessed",
              slug: "recessed",
              parentId: A,
              order: 0,
              description: null,
              children: [],
            },
          ],
        },
      ]),
    ).toEqual([
      { id: A, label: "Spot Lights" },
      { id: A1, label: "Spot Lights › Recessed" },
    ]);
  });
});

describe("ProductNewForm", () => {
  it("labels both fields", () => {
    const html = renderToStaticMarkup(
      createElement(ProductNewForm, {
        categories: [{ id: A, label: "Spot Lights" }],
      }),
    );
    for (const id of ["product-name", "product-main-category"]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("Create draft");
  });

  it("checks the same rules as the server", () => {
    expect(
      newProductSchema.safeParse({ name: " Arc ", mainCategory: A }).data,
    ).toEqual({ name: "Arc", mainCategory: A });
    expect(
      newProductSchema.safeParse({ name: "", mainCategory: A }).success,
    ).toBe(false);
    expect(
      newProductSchema.safeParse({ name: "x".repeat(201), mainCategory: A })
        .success,
    ).toBe(false);
    expect(
      newProductSchema.safeParse({ name: "Arc", mainCategory: "" }).success,
    ).toBe(false);
    expect(
      newProductSchema.safeParse({ name: "Arc", mainCategory: A, extra: 1 })
        .success,
    ).toBe(false);
  });

  it("puts field errors on the inputs and the rest above the form", () => {
    const setError = vi.fn();
    const messages = applyNewProductErrors(
      { setError },
      {
        formErrors: [],
        fieldErrors: {
          mainCategory: ["This category no longer exists"],
          slug: ["Another product already uses this slug."],
        },
      },
    );
    expect(setError).toHaveBeenCalledOnce();
    expect(setError).toHaveBeenCalledWith(
      "mainCategory",
      { type: "server", message: "This category no longer exists" },
      { shouldFocus: true },
    );
    expect(messages).toEqual(["Another product already uses this slug."]);
  });
});

describe("urlWithoutNotice", () => {
  it("drops only the notice and keeps the rest", () => {
    expect(
      urlWithoutNotice("http://localhost/admin/areas?notice=created"),
    ).toBe("/admin/areas");
    expect(
      urlWithoutNotice("http://localhost/admin/x?a=1&notice=deleted#top"),
    ).toBe("/admin/x?a=1#top");
  });

  it("returns null when there is nothing to remove", () => {
    expect(urlWithoutNotice("http://localhost/admin/areas")).toBeNull();
  });
});
