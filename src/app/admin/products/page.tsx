// Admin products list: search, status and category filters, 25 rows a page,
// the "saved" notice after a redirect, and empty states. Filters live in the
// URL. requireAdmin() first (rule 3; the layout doesn't re-run on client nav).

import type { Metadata } from "next";
import { Package, Plus, SearchX } from "lucide-react";
import Link from "next/link";

import { NEW_CATEGORY_PATH } from "@/components/admin/category-paths";
import {
  ALL,
  ProductFilters,
  type ProductFilterValues,
} from "@/components/admin/product-filters";
import { categoryOptions } from "@/components/admin/product-category-options";
import {
  NEW_PRODUCT_PATH,
  PRODUCTS_PATH,
  productsListPath,
} from "@/components/admin/product-paths";
import {
  ProductsPager,
  ProductsTable,
} from "@/components/admin/products-table";
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
import { listCategoryTree } from "@/lib/admin/categories";
import { listProducts, MAX_PRODUCT_SEARCH_LENGTH } from "@/lib/admin/products";
import { requireAdmin } from "@/lib/permissions";
import { PRODUCT_STATUSES } from "@/models/product-constants";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Products" };

const NOTICES = {
  created: "Product created.",
  updated: "Product saved.",
  unchanged: "No changes to save.",
  deleted: "Product deleted.",
} as const;

/* One search-param value as a string ("" when missing or repeated). */
function single(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function AdminProductsPage({
  searchParams,
}: PageProps<"/admin/products">) {
  await requireAdmin();
  const [tree, query] = await Promise.all([listCategoryTree(), searchParams]);

  const categories = categoryOptions(tree);

  /*
   * Only values the filters can show are applied, so the form and the rows
   * always agree: an unknown status or a deleted category reads as "all".
   * The service re-checks everything anyway (bad values fall back).
   */
  const q = single(query.q).trim().slice(0, MAX_PRODUCT_SEARCH_LENGTH).trim();
  const rawStatus = single(query.status);
  const status = (PRODUCT_STATUSES as readonly string[]).includes(rawStatus)
    ? rawStatus
    : undefined;
  const rawCategory = single(query.category).toLowerCase();
  const category = categories.some((option) => option.id === rawCategory)
    ? rawCategory
    : undefined;

  const result = await listProducts({
    q,
    status,
    category,
    page: query.page,
  });
  const notice = readNotice(query[NOTICE_PARAM]);

  const filters: ProductFilterValues = {
    q,
    status: status ?? ALL,
    category: category ?? ALL,
  };
  const filtered = q !== "" || status !== undefined || category !== undefined;
  const listQuery = { q, status, category };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Products</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {filtered
              ? `${result.total} matching ${result.total === 1 ? "product" : "products"}.`
              : `Drafts stay hidden from the site until published. ${result.total} in total.`}
          </p>
        </div>
        {categories.length > 0 ? (
          <Button asChild>
            <Link href={NEW_PRODUCT_PATH}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              New product
            </Link>
          </Button>
        ) : null}
      </div>

      <SaveNoticeAlert notice={notice} messages={NOTICES} />

      {result.total === 0 && !filtered ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Package aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No products yet</EmptyTitle>
            <EmptyDescription>
              {categories.length > 0
                ? "Create the first product as a draft, then fill in its specs and images."
                : "Every product needs a category, so add the categories first."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link
                href={
                  categories.length > 0 ? NEW_PRODUCT_PATH : NEW_CATEGORY_PATH
                }
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {categories.length > 0 ? "New product" : "New category"}
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <ProductFilters
            values={filters}
            categories={categories}
            filtered={filtered}
          />

          {result.items.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>
                  {result.total === 0
                    ? "No products match"
                    : "Nothing on this page"}
                </EmptyTitle>
                <EmptyDescription>
                  {result.total === 0
                    ? "Try another search or fewer filters. Model numbers match in part, e.g. AR-013."
                    : "This page number is past the end of the list."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild variant="outline">
                  <Link
                    href={
                      result.total === 0
                        ? PRODUCTS_PATH
                        : productsListPath(listQuery)
                    }
                  >
                    {result.total === 0 ? "Clear filters" : "Go to page 1"}
                  </Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <ProductsTable rows={result.items} />
          )}

          <ProductsPager
            query={listQuery}
            page={result.page}
            pageCount={result.pageCount}
          />
        </>
      )}
    </div>
  );
}
