// Admin categories list: the whole tree (main categories with their
// subcategories), the "saved" notice after a redirect, and an empty state.
// requireAdmin() first (rule 3; the layout doesn't re-run on client nav).

import type { Metadata } from "next";
import { FolderTree, Plus } from "lucide-react";
import Link from "next/link";

import { NEW_CATEGORY_PATH } from "@/components/admin/category-paths";
import {
  CategoryTree,
  type CategoryTreeItem,
} from "@/components/admin/category-tree";
import { NOTICE_PARAM, readNotice } from "@/components/admin/save-notice";
import { SaveNoticeAlert } from "@/components/admin/save-notice-alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  listCategoryTree,
  type CategoryTreeNode,
} from "@/lib/admin/categories";
import { requireAdmin } from "@/lib/permissions";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Categories" };

const NOTICES = {
  created: "Category created.",
  updated: "Category saved.",
  unchanged: "No changes to save.",
  deleted: "Category deleted.",
} as const;

/*
 * Only what the client tree renders crosses to the browser (no
 * descriptions, orders or parent ids), keeping the payload small.
 */
function toItem(node: CategoryTreeNode): CategoryTreeItem {
  return {
    id: node.id,
    name: node.name,
    slug: node.slug,
    children: node.children.map(toItem),
  };
}

export default async function AdminCategoriesPage({
  searchParams,
}: PageProps<"/admin/categories">) {
  await requireAdmin();
  const [tree, query] = await Promise.all([listCategoryTree(), searchParams]);
  const notice = readNotice(query[NOTICE_PARAM]);
  const subcategoryCount = tree.reduce(
    (sum, node) => sum + node.children.length,
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Categories</h1>
          <p className="text-sm text-muted-foreground">
            Product types, shown in this order on the site.{" "}
            {tree.length > 0
              ? `${tree.length} main, ${subcategoryCount} sub.`
              : null}
          </p>
        </div>
        {tree.length > 0 ? (
          <Button asChild>
            <Link href={NEW_CATEGORY_PATH}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              New category
            </Link>
          </Button>
        ) : null}
      </div>

      <SaveNoticeAlert notice={notice} messages={NOTICES} />

      {tree.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderTree aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No categories yet</EmptyTitle>
            <EmptyDescription>
              Start with the main product types, such as Spot Lights. Add
              subcategories under them afterwards.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link href={NEW_CATEGORY_PATH}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                New category
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <CategoryTree items={tree.map(toItem)} />
      )}
    </div>
  );
}
