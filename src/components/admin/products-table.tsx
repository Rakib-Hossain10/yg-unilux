// The products table on /admin/products (one page of rows: name, model code
// and family, main category, variants, status, last edit) and its pager.
// Server-rendered: links only, no client JavaScript.

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ProductStatus } from "@/models/product-constants";

import {
  productEditPath,
  productsListPath,
  type ProductListQuery,
} from "./product-paths";

/** One row as the table needs it (the page passes the service's rows). */
export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  family: string | null;
  modelCode: string | null;
  firstModelNo: string | null;
  mainCategoryName: string | null;
  variantCount: number;
  status: ProductStatus;
  updatedAt: string;
}

/*
 * Dates as "6 Oct 2026" in UTC: the same text on the server and in any
 * browser, so nothing shifts between renders. Created once per module.
 */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function ProductsTable({ rows }: { rows: ProductRow[] }) {
  return (
    <div className="rounded-lg border">
      <Table aria-label="Products">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Product</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Main category</TableHead>
            <TableHead className="text-right">Variants</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="pr-4">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const model = row.modelCode ?? row.firstModelNo;
            return (
              <TableRow key={row.id}>
                <TableCell className="max-w-72 pl-4">
                  {/* Long values are cut with an ellipsis; `title` keeps
                      the full text available on hover. */}
                  <Link
                    href={productEditPath(row.id)}
                    title={row.name}
                    className="block truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                  >
                    {row.name}
                  </Link>
                  <span
                    title={`/product/${row.slug}`}
                    className="block truncate text-muted-foreground"
                  >
                    /product/{row.slug}
                  </span>
                </TableCell>
                <TableCell className="max-w-56">
                  <span title={model ?? undefined} className="block truncate">
                    {model ?? "—"}
                  </span>
                  {row.family ? (
                    <span
                      title={row.family}
                      className="block truncate text-muted-foreground"
                    >
                      {row.family}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-56">
                  {row.mainCategoryName ? (
                    <span
                      title={row.mainCategoryName}
                      className="block truncate"
                    >
                      {row.mainCategoryName}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      Missing category
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.variantCount}
                </TableCell>
                <TableCell>
                  {row.status === "published" ? (
                    <Badge>Published</Badge>
                  ) : (
                    <Badge variant="outline">Draft</Badge>
                  )}
                </TableCell>
                <TableCell className="pr-4 text-muted-foreground">
                  <time dateTime={row.updatedAt}>
                    {DATE_FORMAT.format(new Date(row.updatedAt))}
                  </time>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * "Page 2 of 7" with Previous/Next links that keep the current filters. An
 * unavailable direction is a disabled button, not a link, so it can't be
 * followed or focused.
 */
export function ProductsPager({
  query,
  page,
  pageCount,
}: {
  /** The filters in force (without the page). */
  query: Omit<ProductListQuery, "page">;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1 && page <= 1) return null;
  const previous = Math.min(page - 1, pageCount);
  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  return (
    <nav
      aria-label="Product pages"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-muted-foreground">
        Page {page} of {pageCount}
      </p>
      <div className="flex gap-2">
        {hasPrevious ? (
          <Button asChild variant="outline" size="sm">
            <Link href={productsListPath({ ...query, page: previous })}>
              <ChevronLeft data-icon="inline-start" aria-hidden="true" />
              Previous
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft data-icon="inline-start" aria-hidden="true" />
            Previous
          </Button>
        )}
        {hasNext ? (
          <Button asChild variant="outline" size="sm">
            <Link href={productsListPath({ ...query, page: page + 1 })}>
              Next
              <ChevronRight data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Next
            <ChevronRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        )}
      </div>
    </nav>
  );
}
