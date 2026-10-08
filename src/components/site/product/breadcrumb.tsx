// Product breadcrumb: Products › main category › sub category › product,
// from the cached category tree (ADR 0063). A <nav> with an ordered list and
// aria-current on the last step. Server Component.

import Link from "next/link";

import type { BreadcrumbItem } from "@/lib/catalog/view";

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
  /** The product's name, shown last and not linked. */
  current: string;
}) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-grey-600">
      <ol className="flex flex-wrap items-center gap-x-2">
        <li className="flex items-center gap-2">
          <Link href="/products" className={crumbLink}>
            Products
          </Link>
          <Separator />
        </li>
        {categories.map((category) => (
          <li key={category.id} className="flex items-center gap-2">
            {/* The listing route and its URL filters arrive in Phase 4b (plan Q6). */}
            <Link
              href={`/products?category=${encodeURIComponent(category.slug)}`}
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
