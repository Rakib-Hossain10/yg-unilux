// Render tests for the categories UI without a browser: the tree's rows,
// labels and edge buttons, the form's labelled fields and locked parent, the
// server-error mapping, and the fixed list of "saved" notices.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The real actions need a session and a database; these never run here.
vi.mock("@/app/admin/categories/actions", () => ({
  createCategoryAction: vi.fn(),
  updateCategoryAction: vi.fn(),
  moveCategoryAction: vi.fn(),
  deleteCategoryAction: vi.fn(),
}));

import { ACTION_FAILED_MESSAGE, callAction } from "./action-result";
import { applyServerErrors, CategoryForm } from "./category-form";
import { CategoryTree, type CategoryTreeItem } from "./category-tree";
import { readNotice, withNotice } from "./save-notice";

const A = "65f0c0ffee0000000000000a";
const A1 = "65f0c0ffee00000000000a01";
const A2 = "65f0c0ffee00000000000a02";
const B = "65f0c0ffee0000000000000b";

const items: CategoryTreeItem[] = [
  {
    id: A,
    name: "Spot Lights",
    slug: "spot-lights",
    children: [
      { id: A1, name: "Recessed", slug: "recessed", children: [] },
      { id: A2, name: "Surface", slug: "surface", children: [] },
    ],
  },
  { id: B, name: "Track Lights", slug: "track-lights", children: [] },
];

/* The opening tag of the button with this accessible name. */
function buttonTag(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(
    html,
  );
  if (!match) throw new Error(`no button labelled ${label}`);
  return match[0];
}

describe("CategoryTree", () => {
  const html = renderToStaticMarkup(createElement(CategoryTree, { items }));

  it("nests subcategories in their own labelled list", () => {
    expect(html).toContain('aria-label="Categories"');
    expect(html).toContain('aria-label="Subcategories of Spot Lights"');
    expect(html).toContain("/recessed");
    expect(html).toContain("2 subcategories");
  });

  it("marks only the edge move buttons as unavailable", () => {
    expect(buttonTag(html, "Move Spot Lights up")).toContain(
      'aria-disabled="true"',
    );
    expect(buttonTag(html, "Move Spot Lights down")).toContain(
      'aria-disabled="false"',
    );
    expect(buttonTag(html, "Move Track Lights down")).toContain(
      'aria-disabled="true"',
    );
    expect(buttonTag(html, "Move Recessed up")).toContain(
      'aria-disabled="true"',
    );
    expect(buttonTag(html, "Move Surface up")).toContain(
      'aria-disabled="false"',
    );
  });

  it("links to edit and to add a subcategory under main categories only", () => {
    expect(html).toContain(`href="/admin/categories/${A}"`);
    expect(html).toContain(`href="/admin/categories/new?parent=${A}"`);
    expect(html).not.toContain(`new?parent=${A1}`);
    expect(buttonTag(html, "Delete Recessed")).toContain('type="button"');
  });
});

describe("CategoryForm", () => {
  const parents = [{ id: A, name: "Spot Lights" }];

  it("labels every field", () => {
    const html = renderToStaticMarkup(createElement(CategoryForm, { parents }));
    for (const id of [
      "category-name",
      "category-slug",
      "category-parent",
      "category-description",
    ]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain("Create category");
    expect(html).toContain("Leave blank to make one from the name");
  });

  it("shows the edit wording and a read-only parent when it is locked", () => {
    const html = renderToStaticMarkup(
      createElement(CategoryForm, {
        parents: [],
        category: {
          id: A,
          name: "Spot Lights",
          slug: "spot-lights",
          parentId: null,
          description: null,
        },
        parentLockedReason: "It has subcategories.",
      }),
    );
    expect(html).toContain("Save changes");
    expect(html).toContain('value="spot-lights"');
    expect(html).toContain("It has subcategories.");
    const trigger = /<button[^>]*id="category-parent"[^>]*>/.exec(html)?.[0];
    expect(trigger).toMatch(/\sdisabled(=""|\s|>)/);
  });
});

describe("applyServerErrors", () => {
  it("puts known fields on the form, focusing the first, and lists the rest", () => {
    const setError = vi.fn();
    const messages = applyServerErrors(
      { setError },
      {
        formErrors: ["The change was saved, but…"],
        fieldErrors: {
          slug: ["Slug taken"],
          parent: ["Too deep"],
          id: ["Invalid id"],
        },
      },
    );
    expect(setError).toHaveBeenNthCalledWith(
      1,
      "slug",
      { type: "server", message: "Slug taken" },
      { shouldFocus: true },
    );
    expect(setError).toHaveBeenNthCalledWith(
      2,
      "parent",
      { type: "server", message: "Too deep" },
      { shouldFocus: false },
    );
    expect(messages).toEqual(["The change was saved, but…", "Invalid id"]);
  });
});

describe("save notices", () => {
  it("round-trips the fixed keys", () => {
    expect(withNotice("/admin/categories", "created")).toBe(
      "/admin/categories?notice=created",
    );
    expect(readNotice("deleted")).toBe("deleted");
  });

  it("refuses a path that already has a query or hash", () => {
    expect(() => withNotice("/admin/products?status=draft", "updated")).toThrow(
      TypeError,
    );
    expect(() => withNotice("/admin/products#top", "updated")).toThrow(
      TypeError,
    );
  });

  it.each([undefined, "", "Created", "<script>", ["created", "deleted"]])(
    "ignores anything else: %j",
    (value) => {
      expect(readNotice(value)).toBeNull();
    },
  );
});

describe("callAction", () => {
  it("passes a result through", async () => {
    expect(await callAction(async () => ({ ok: true }))).toEqual({ ok: true });
  });

  it("turns a thrown failure into an error result", async () => {
    const result = await callAction(async () => {
      throw new Error("fetch failed");
    });
    expect(result).toEqual({
      ok: false,
      saved: "unknown",
      errors: { formErrors: [ACTION_FAILED_MESSAGE], fieldErrors: {} },
    });
  });

  it("rethrows Next's redirect so the router can navigate", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;push;/admin/categories?notice=created;307;",
    });
    await expect(
      callAction(async () => {
        throw redirectError;
      }),
    ).rejects.toBe(redirectError);
  });
});
