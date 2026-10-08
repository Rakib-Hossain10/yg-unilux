// Catalog breadcrumb: Products › main category › sub category › current
// page (a product, or the category of a listing page), from the cached
// category tree (ADR 0063). Category steps link to their listing paths
// (/products/<main>/<sub>: sub slugs repeat across parents, ADR 0065). A
// <nav> with an ordered list and aria-current on the last step. Server
// Component.

import Link from "next/link";

import type { BreadcrumbItem } from "@/lib/catalog/view";

import { categoryListingPath, PRODUCTS_PATH } from "../listing/listing-urls";

function Separator() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden="true"
      focusable="false"
      className="shrink-0 text-grey-400"
    >
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

const crumbLink =
  "inline-flex min-h-11 items-center underline-offset-4 transition-colors duration-(--duration-quick) hover:text-ink hover:underline";

export function ProductBreadcrumb({
  categories,
  current,
}: {
  categories: readonly BreadcrumbItem[];
  /** The current page's name (product or category), shown last, unlinked. */
  current: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-grey-600">
      <ol className="flex flex-wrap items-center gap-x-2">
        <li className="flex items-center gap-2">
          <Link href={PRODUCTS_PATH} className={crumbLink}>
            Products
          </Link>
          <Separator />
        </li>
        {categories.map((category, index) => (
          <li key={category.id} className="flex items-center gap-2">
            <Link
              href={categoryListingPath(categories.slice(0, index + 1))}
              className={crumbLink}
            >
              {category.name}
            </Link>
            <Separator />
          </li>
        ))}
        <li className="flex min-h-11 items-center">
          <span aria-current="page" className="text-ink">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}
