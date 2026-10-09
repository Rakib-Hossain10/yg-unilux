// /search?q=: the full search results page (Phase 4b L6, plan Q9, ADR 0066).
// Works without JavaScript (a GET form); the header overlay's Enter and
// "See all results" land here. Rendered on request (reads searchParams) from
// searchCatalog(), whose product answers are cached per normalised query.
// Cards come from ListingCardView (no spec value, rule 9); a model-no. hit
// links to /product/<slug>?model=<modelNo>. Never indexed.

import type { Metadata } from "next";
import Link from "next/link";

import { siteCloudName } from "@/components/site/cloudinary-image";
import { ListingGrid } from "@/components/site/listing/listing-card";
import { PRODUCTS_PATH } from "@/components/site/listing/listing-urls";
import { toListingCards } from "@/components/site/listing/listing-view";
import {
  resultSummary,
  SEARCH_INPUT_MAX_LENGTH,
  SEARCH_PATH,
  searchCategoryHref,
  searchProductHref,
} from "@/components/site/search/search-links";
import { SearchIcon } from "@/components/site/icons";
import {
  MAX_PRODUCT_HITS,
  searchCatalog,
  type SearchResult,
} from "@/lib/catalog/search";

/*
 * Never import @/lib/catalog/restricted, the session or next/headers here
 * (rule 9; the listing static guard pattern).
 */

/** The raw `q` (first value), cut to what the input can hold. */
function rawQuery(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return "";
  return [...first.trim()].slice(0, SEARCH_INPUT_MAX_LENGTH).join("");
}

export async function generateMetadata(
  props: PageProps<"/search">,
): Promise<Metadata> {
  const q = rawQuery((await props.searchParams).q);
  return {
    title: q ? `Search: ${q}` : "Search",
    // Result pages are never indexed; their links are followed.
    robots: { index: false, follow: true },
  };
}

const container = "mx-auto w-full max-w-(--container-site) px-4 md:px-8";

export default async function SearchPage(props: PageProps<"/search">) {
  const q = rawQuery((await props.searchParams).q);
  // searchCatalog normalises and answers an empty result for < 2 chars.
  const result: SearchResult =
    q === ""
      ? { query: "", products: [], categories: [] }
      : await searchCatalog(q);
  const cloudName = siteCloudName();
  const cards = toListingCards(result.products, cloudName).map(
    (card, index) => {
      const hit = result.products[index];
      return hit
        ? {
            ...card,
            href: searchProductHref(hit),
            // A model-no. hit shows the model that matched.
            modelCode: hit.matchedModelNo ?? card.modelCode,
          }
        : card;
    },
  );
  const searched = result.query !== "";
  const total = result.products.length + result.categories.length;

  return (
    <div
      data-slot="search-page"
      className={`${container} pt-8 pb-24 md:pt-12 md:pb-32`}
    >
      <h1 className="font-display text-5xl leading-[1.02] font-light md:text-6xl">
        Search
      </h1>

      <form
        role="search"
        action={SEARCH_PATH}
        method="get"
        className="mt-8 flex max-w-3xl items-center gap-3 border-b border-grey-300 focus-within:border-ink md:mt-10"
      >
        <SearchIcon className="size-5 shrink-0 text-grey-600" />
        <label htmlFor="search-page-q" className="sr-only">
          Search products
        </label>
        <input
          id="search-page-q"
          name="q"
          type="search"
          defaultValue={q}
          maxLength={SEARCH_INPUT_MAX_LENGTH}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Name, family or model no."
          className="min-w-0 flex-1 bg-transparent py-3 font-display text-2xl font-light outline-none placeholder:text-grey-400 md:text-3xl"
        />
        <button
          type="submit"
          className="inline-flex min-h-11 shrink-0 cursor-pointer items-center px-3 text-sm text-ink underline decoration-grey-300 underline-offset-4 hover:decoration-ink"
        >
          Search
        </button>
      </form>

      <p
        data-slot="search-summary"
        className="mt-6 text-[0.9375rem] text-grey-700"
      >
        {!searched
          ? q === ""
            ? "Type a product name, family or model number."
            : "Type at least 2 characters."
          : total === 0
            ? `No products or categories match “${result.query}”.`
            : `${resultSummary(result.products.length, result.categories.length)} for “${result.query}”.`}
      </p>

      {searched && total === 0 ? (
        <p className="mt-2 text-[0.9375rem] text-grey-700">
          Check the spelling, try part of a model number, or{" "}
          <Link
            href={PRODUCTS_PATH}
            className="text-ink underline decoration-grey-300 underline-offset-4 hover:decoration-ink"
          >
            browse all products
          </Link>
          .
        </p>
      ) : null}

      {result.categories.length > 0 ? (
        <section aria-labelledby="search-categories" className="mt-12">
          <h2 id="search-categories" className="text-sm text-grey-600">
            Categories
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-8">
            {result.categories.map((hit) => (
              <li key={hit.id}>
                <Link
                  href={searchCategoryHref(hit)}
                  className="inline-flex min-h-11 items-center text-[0.9375rem] text-ink underline decoration-grey-300 underline-offset-4 hover:decoration-ink"
                >
                  {hit.path.join(" › ")}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {cards.length > 0 ? (
        <section aria-labelledby="search-products" className="mt-12">
          <h2 id="search-products" className="mb-6 text-sm text-grey-600">
            Products
          </h2>
          <ListingGrid cards={cards} />
          {result.products.length >= MAX_PRODUCT_HITS ? (
            <p className="mt-10 text-[0.9375rem] text-grey-700">
              These are the {MAX_PRODUCT_HITS} closest matches. Add more of the
              name or model number to narrow them down.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
