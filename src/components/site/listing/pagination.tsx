// Numbered pagination links (plan Q5): crawlable <a> links, previous/next,
// the current page marked with aria-current. Server Component.

import Link from "next/link";

import type { ListingParams } from "@/lib/catalog/listing-params";

import { ArrowLeftIcon, ArrowRightIcon } from "../icons";
import { pageHref, paginationItems } from "./listing-urls";

const cell =
  "inline-flex size-11 items-center justify-center text-sm tabular-nums transition-colors duration-(--duration-quick)";

export function Pagination({
  basePath,
  params,
  page,
  pageCount,
}: {
  basePath: string;
  params: ListingParams;
  page: number;
  pageCount: number;
}) {
  const items = paginationItems(page, pageCount);
  if (items.length === 0) return null;
  return (
    <nav
      aria-label="Pagination"
      data-slot="pagination"
      className="mt-16 flex items-center justify-center border-t border-grey-200 pt-6"
    >
      <ul className="flex flex-wrap items-center justify-center gap-1">
        {page > 1 ? (
          <li>
            <Link
              href={pageHref(basePath, params, page - 1)}
              aria-label="Previous page"
              rel="prev"
              className={`${cell} text-ink hover:bg-grey-100`}
            >
              <ArrowLeftIcon />
            </Link>
          </li>
        ) : null}
        {items.map((item, index) =>
          item === "gap" ? (
            <li
              key={`gap-${index}`}
              aria-hidden="true"
              className={`${cell} text-grey-500`}
            >
              …
            </li>
          ) : (
            <li key={item}>
              {item === page ? (
                <span
                  aria-current="page"
                  className={`${cell} border-b border-ink font-medium text-ink`}
                >
                  <span className="sr-only">Page </span>
                  {item}
                </span>
              ) : (
                <Link
                  href={pageHref(basePath, params, item)}
                  className={`${cell} text-grey-700 hover:bg-grey-100 hover:text-ink`}
                >
                  <span className="sr-only">Page </span>
                  {item}
                </Link>
              )}
            </li>
          ),
        )}
        {page < pageCount ? (
          <li>
            <Link
              href={pageHref(basePath, params, page + 1)}
              aria-label="Next page"
              rel="next"
              className={`${cell} text-ink hover:bg-grey-100`}
            >
              <ArrowRightIcon />
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
