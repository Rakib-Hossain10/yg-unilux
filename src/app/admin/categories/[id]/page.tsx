// Edit page for one category. A category with subcategories must stay a main
// category (depth 2, ADR 0037), so its parent picker is read-only. An unknown
// or malformed id shows the segment's not-found page. requireAdmin() first.

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/admin/back-link";
import { CategoryForm } from "@/components/admin/category-form";
import { CATEGORIES_PATH } from "@/components/admin/category-paths";
import { getCategoryForEdit, listCategoryTree } from "@/lib/admin/categories";
import { requireAdmin } from "@/lib/permissions";

// Static only (ADR 0036): never the category's name.
export const metadata: Metadata = { title: "Edit category" };

export default async function EditCategoryPage({
  params,
}: PageProps<"/admin/categories/[id]">) {
  await requireAdmin();
  const { id } = await params;
  // The service validates the id; a bad one is simply "not found".
  const [category, tree] = await Promise.all([
    getCategoryForEdit(id),
    listCategoryTree(),
  ]);
  if (!category) notFound();

  const subcategories =
    tree.find((node) => node.id === category.id)?.children.length ?? 0;
  // Main categories other than this one.
  const parents = tree
    .filter((node) => node.id !== category.id)
    .map(({ id: parentId, name }) => ({ id: parentId, name }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={CATEGORIES_PATH}>Categories</BackLink>
        <h1 className="text-2xl font-semibold">Edit {category.name}</h1>
      </div>
      <CategoryForm
        category={category}
        parents={parents}
        parentLockedReason={
          subcategories > 0
            ? "This category has subcategories, so it stays a main category. Move them first to change its parent."
            : null
        }
      />
    </div>
  );
}
