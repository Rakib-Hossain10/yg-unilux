// New product page: name + main category create a draft, then the action opens
// its edit page. With no categories yet it points to creating one first.
// requireAdmin() first (rule 3).

import type { Metadata } from "next";
import { FolderTree, Plus } from "lucide-react";
import Link from "next/link";

import { BackLink } from "@/components/admin/back-link";
import { NEW_CATEGORY_PATH } from "@/components/admin/category-paths";
import { categoryOptions } from "@/components/admin/product-category-options";
import { ProductNewForm } from "@/components/admin/product-new-form";
import { PRODUCTS_PATH } from "@/components/admin/product-paths";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { listCategoryTree } from "@/lib/admin/categories";
import { requireAdmin } from "@/lib/permissions";

import { pageActor, readAsAdmin } from "../../admin-reads";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage() {
  const viewer = await requireAdmin();
  const actor = await pageActor(viewer);
  // Only ids and labels cross to the browser.
  const categories = categoryOptions(
    await readAsAdmin(() => listCategoryTree(actor)),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={PRODUCTS_PATH}>Products</BackLink>
        <h1 className="text-2xl font-semibold">New product</h1>
        <p className="text-sm text-muted-foreground">
          Start a draft. It stays hidden from the site until you publish it.
        </p>
      </div>

      {categories.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderTree aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Add a category first</EmptyTitle>
            <EmptyDescription>
              Every product needs a main category, such as Spot Lights.
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
        <ProductNewForm categories={categories} />
      )}
    </div>
  );
}
