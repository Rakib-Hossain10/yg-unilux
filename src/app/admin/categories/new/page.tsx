// New category page. The parent picker lists main categories only;
// ?parent=<id> (from "Add subcategory") presets it when that id is one of
// them. requireAdmin() first (rule 3).

import type { Metadata } from "next";

import { BackLink } from "@/components/admin/back-link";
import { CategoryForm } from "@/components/admin/category-form";
import { CATEGORIES_PATH } from "@/components/admin/category-paths";
import { listCategoryTree } from "@/lib/admin/categories";
import { requireAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "New category" };

export default async function NewCategoryPage({
  searchParams,
}: PageProps<"/admin/categories/new">) {
  await requireAdmin();
  const [tree, query] = await Promise.all([listCategoryTree(), searchParams]);

  // Main categories only: the depth limit is 2 levels (ADR 0037).
  const parents = tree.map(({ id, name }) => ({ id, name }));
  // Compared against the offered ids, so a crafted value is just ignored.
  const wanted = query.parent;
  const defaultParentId =
    typeof wanted === "string" && parents.some((p) => p.id === wanted)
      ? wanted
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={CATEGORIES_PATH}>Categories</BackLink>
        <h1 className="text-2xl font-semibold">New category</h1>
      </div>
      <CategoryForm parents={parents} defaultParentId={defaultParentId} />
    </div>
  );
}
