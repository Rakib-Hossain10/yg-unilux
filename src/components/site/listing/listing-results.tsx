// The results half of a listing page (category pages now, area pages in L5):
// a toolbar (count, mobile "Filters (n)" sheet, sort), removable chips of
// the applied filters, the desktop filter rail, the card grid, numbered
// pagination and the empty states. Server Component with small client leaves
// (FilterForm, FilterSheet, SortControl). It renders only card data and
// facet counts: no spec value can reach it.

import Link from "next/link";

import type { ListingFacets } from "@/lib/catalog/facets";
import { countActiveFilters } from "@/lib/catalog/listing-params";
import type { ListingResult } from "@/lib/catalog/listing";

import { CloseIcon } from "../icons";
import { FilterForm } from "./filter-form";
import { FilterSheet } from "./filter-sheet";
import { ListingGrid, type ListingCardData } from "./listing-card";
import { clearFiltersHref, filterChips, listingHref } from "./listing-urls";
import {
  appliedFilterPairs,
  SORT_OPTIONS,
  selectedTokens,
  toFilterGroups,
} from "./listing-view";
import { Pagination } from "./pagination";
import { SortControl } from "./sort-control";

const productsLabel = (n: number) => `${n} ${n === 1 ? "product" : "products"}`;

const textLink =
  "inline-flex min-h-11 items-center text-sm text-ink underline decoration-grey-400 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink";

export function ListingResults({
  basePath,
  result,
  facets,
  cards,
  categoryNames,
  emptyScope,
}: {
  /** The listing's path (no query): forms and links build on it. */
  basePath: string;
  result: ListingResult;
  facets: ListingFacets;
  cards: readonly ListingCardData[];
  /** `cat` slug → name, for chips on area pages. */
  categoryNames?: ReadonlyMap<string, string>;
  /** What to say when the scope has no product at all. */
  emptyScope: { message: string; href: string; linkLabel: string };
}) {
  const { params, total } = result;
  const activeCount = countActiveFilters(params);
  const chips = filterChips(basePath, params, categoryNames);
  const clearHref = activeCount > 0 ? clearFiltersHref(basePath, params) : null;
  const groups = toFilterGroups(facets);
  const hasFilters = groups.length > 0;
  const appliedKey = listingHref("", { ...params, page: 1 });
  const selected = selectedTokens(params);
  const formProps = {
    action: basePath,
    groups,
    selected,
    sort: params.sort,
    appliedKey,
    total,
  };

  return (
    <div data-slot="listing-results">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-grey-200 py-3">
        <p
          className="text-sm text-grey-600 tabular-nums"
          data-slot="result-count"
        >
          {activeCount > 0 && facets.total > 0
            ? `${total} of ${productsLabel(facets.total)}`
            : productsLabel(total)}
        </p>
        <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
          {hasFilters ? (
            <FilterSheet
              activeCount={activeCount}
              total={total}
              clearHref={clearHref}
            >
              <FilterForm idPrefix="sheet" {...formProps} />
            </FilterSheet>
          ) : null}
          {facets.total > 1 ? (
            <SortControl
              idPrefix="listing"
              action={basePath}
              options={SORT_OPTIONS}
              sort={params.sort}
              hiddenFields={appliedFilterPairs(params)}
            />
          ) : null}
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-4">
          <h2 className="sr-only">Active filters</h2>
          <ul className="flex flex-wrap gap-2" data-slot="filter-chips">
            {chips.map((chip) => (
              <li key={`${chip.param}=${chip.value}`}>
                <Link
                  href={chip.href}
                  scroll={false}
                  aria-label={`Remove filter ${chip.facetLabel} ${chip.label}`}
                  className="inline-flex h-11 items-center gap-2 border border-grey-300 bg-grey-50 pr-3 pl-4 text-sm text-ink transition-colors duration-(--duration-quick) hover:border-ink"
                >
                  {chip.label}
                  <CloseIcon className="size-3.5 text-grey-600" />
                </Link>
              </li>
            ))}
          </ul>
          {clearHref ? (
            <Link href={clearHref} scroll={false} className={textLink}>
              Clear all
            </Link>
          ) : null}
        </div>
      ) : null}

      <div
        className={`mt-8 grid gap-10 md:mt-10 ${hasFilters ? "lg:grid-cols-12 lg:gap-12" : ""}`}
      >
        {hasFilters ? (
          <aside
            aria-labelledby="listing-filters-heading"
            data-slot="filter-rail"
            className="hidden lg:col-span-3 lg:block noscript:block"
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2
                id="listing-filters-heading"
                className="font-display text-2xl font-light"
              >
                Filters
              </h2>
              {clearHref ? (
                <Link href={clearHref} scroll={false} className={textLink}>
                  Clear all
                </Link>
              ) : null}
            </div>
            <FilterForm idPrefix="rail" {...formProps} />
          </aside>
        ) : null}

        <section
          aria-labelledby="listing-results-heading"
          className={hasFilters ? "lg:col-span-9" : ""}
        >
          <h2 id="listing-results-heading" className="sr-only">
            Products
          </h2>
          {cards.length > 0 ? (
            <>
              <ListingGrid cards={cards} />
              <Pagination
                basePath={basePath}
                params={params}
                page={result.page}
                pageCount={result.pageCount}
              />
            </>
          ) : activeCount > 0 ? (
            <EmptyState
              title="No products match these filters"
              message="Remove a filter above, or clear them all to see every product here."
              href={clearHref ?? basePath}
              linkLabel="Clear all filters"
            />
          ) : (
            <EmptyState
              title="Nothing here yet"
              message={emptyScope.message}
              href={emptyScope.href}
              linkLabel={emptyScope.linkLabel}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  message,
  href,
  linkLabel,
}: {
  title: string;
  message: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <div
      data-slot="listing-empty"
      className="border-t border-ink py-12 md:py-16"
    >
      <p className="font-display text-3xl font-light text-balance md:text-4xl">
        {title}
      </p>
      <p className="mt-3 max-w-md text-grey-600">{message}</p>
      <Link
        href={href}
        scroll={false}
        className="mt-8 inline-flex h-11 items-center border border-ink px-6 text-sm transition-colors duration-(--duration-quick) hover:bg-ink hover:text-paper"
      >
        {linkLabel}
      </Link>
    </div>
  );
}
