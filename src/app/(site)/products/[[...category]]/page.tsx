// /products, /products/<main>, /products/<main>/<sub>: the catalog listing
// (Phase 4b L4, plan Q1-Q6, ADR 0065). Rendered on request (it reads
// searchParams) from cached data: the column visibility is read once, the
// path is resolved on the cached tree, the query is parsed for that
// visibility and scope, then cards and facets are read in parallel. Cards
// and facets hold no spec value, so nothing restricted can reach the HTML.

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  CLOUDINARY_TRANSFORMS,
  cloudinaryImageUrl,
  siteCloudName,
} from "@/components/site/cloudinary-image";
import {
  ListingHeader,
  type ListingSubLink,
} from "@/components/site/listing/listing-header";
import {
  listingLoader,
  readListing,
} from "@/components/site/listing/listing-load";
import { ListingResults } from "@/components/site/listing/listing-results";
import {
  listingMetaDescription,
  listingMetaTitle,
} from "@/components/site/listing/listing-meta";
import {
  categoryListingPath,
  isRefinedListing,
  listingCanonicalPath,
  PRODUCTS_PATH,
} from "@/components/site/listing/listing-urls";
import { toListingCards } from "@/components/site/listing/listing-view";
import { ProductBreadcrumb } from "@/components/site/product/breadcrumb";
import { absoluteSiteUrl } from "@/components/site/site-url";
import {
  listPublicCategories,
  type PublicCategoryView,
} from "@/lib/catalog/categories";
import {
  categoriesWithPublished,
  listPublishedCategoryCounts,
} from "@/lib/catalog/category-counts";
import {
  resolveCategoryPath,
  type CategoryPathView,
} from "@/lib/catalog/category-path";
import type { ListingFacets } from "@/lib/catalog/facets";
import {
  getCatalogVisibility,
  type ListingResult,
} from "@/lib/catalog/listing";
import type { ListingScope } from "@/lib/catalog/listing-scope";

/*
 * Never import @/lib/catalog/restricted, the session or next/headers here or
 * in any listing component (static guard in test/listing-page.test.ts).
 */

/** /products/<main>/<sub> at most (MAX_CATEGORY_DEPTH). */
const MAX_PATH_SEGMENTS = 2;

interface ListingPageData {
  basePath: string;
  /** The resolved category, null on /products. */
  path: CategoryPathView | null;
  /** The category's public record (description, cover), null on /products. */
  category: PublicCategoryView | null;
  tree: PublicCategoryView[];
  /**
   * Ids of categories whose subtree holds a published product (the menu,
   * sitemap and search rule, gate-A I-2): only these are linked, so a
   * draft-only category is never named on another category's page.
   */
  listed: ReadonlySet<string>;
  result: ListingResult;
  facets: ListingFacets;
}

/**
 * Everything a listing request needs, once per request (React cache):
 * null for an unknown or too-deep path. The page answers 404 for null and
 * for a page past the end.
 */
const loadListing = listingLoader(
  async (pathKey, queryKey): Promise<ListingPageData | null> => {
    const segments = pathKey === "" ? [] : pathKey.split("/");
    if (segments.length > MAX_PATH_SEGMENTS) return null;
    const [visibility, tree, counts, path] = await Promise.all([
      getCatalogVisibility(),
      listPublicCategories(),
      listPublishedCategoryCounts(),
      segments.length > 0 ? resolveCategoryPath(segments) : null,
    ]);
    if (segments.length > 0 && path === null) return null;
    const scope: ListingScope = path
      ? { kind: "category", ids: path.subtreeIds }
      : { kind: "all" };
    const { result, facets } = await readListing(scope, queryKey, visibility, {
      track: path?.isMagneticTrack ?? false,
      cat: false,
    });
    const categoryId = path?.category.id;
    return {
      basePath: path ? categoryListingPath(path.path) : PRODUCTS_PATH,
      path,
      category: tree.find((entry) => entry.id === categoryId) ?? null,
      tree,
      listed: categoriesWithPublished(tree, counts),
      result,
      facets,
    };
  },
);

async function loadFromProps(
  props: PageProps<"/products/[[...category]]">,
): Promise<ListingPageData | null> {
  const [{ category }, query] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  const segments = Array.isArray(category) ? category : [];
  return loadListing(segments.join("/"), query);
}

/** Page 2+ of a listing that has fewer pages is not a page. */
const isPastEnd = (data: ListingPageData) =>
  data.result.page > data.result.pageCount;

/**
 * A category whose subtree holds no published product: the page still
 * answers 200 (an empty state), but it is not indexed until it has one.
 */
const isEmptyCategory = (data: ListingPageData) =>
  data.path !== null && !data.listed.has(data.path.category.id);

const ROOT_TITLE = "Products";
const ROOT_DESCRIPTION =
  "Browse the full YG UniLUX catalog by category, or narrow it with the filters.";

/** The page's display title (the h1). */
function headingOf(data: ListingPageData): string {
  return data.path ? data.path.category.name : ROOT_TITLE;
}

function coverOf(
  category: PublicCategoryView | null,
  cloudName: string | null,
): { src: string; alt: string } | null {
  if (!category?.coverImage) return null;
  const src = cloudinaryImageUrl(
    cloudName,
    category.coverImage,
    CLOUDINARY_TRANSFORMS.categoryCover,
  );
  // Decorative: the category name follows as the page heading.
  return src ? { src, alt: "" } : null;
}

export async function generateMetadata(
  props: PageProps<"/products/[[...category]]">,
): Promise<Metadata> {
  const data = await loadFromProps(props);
  if (!data || isPastEnd(data)) {
    return { title: "Page not found", robots: { index: false } };
  }
  const title = listingMetaTitle(
    data.path?.path ?? [],
    ROOT_TITLE,
    data.result.page,
  );
  const description = data.path
    ? listingMetaDescription(
        data.category?.description ?? null,
        `${data.path.category.name} in the YG UniLUX commercial lighting catalog.`,
      )
    : ROOT_DESCRIPTION;
  const canonical = absoluteSiteUrl(
    listingCanonicalPath(data.basePath, data.result.page),
  );
  const cover = coverOf(data.category, siteCloudName());
  return {
    title,
    description,
    ...(canonical ? { alternates: { canonical } } : {}),
    // Any filter or a non-default sort (including the empty answer that
    // keeps unknown values to explain itself), or a category with no
    // published product yet: not indexed, links followed.
    ...(isRefinedListing(data.result.params) || isEmptyCategory(data)
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      type: "website",
      siteName: "YG UniLUX",
      title,
      description,
      ...(canonical ? { url: canonical } : {}),
      ...(cover ? { images: [{ url: cover.src }] } : {}),
    },
  };
}

/**
 * The row of category links under the header: only categories with a
 * published product (the current one always, it is the page's own heading).
 */
function subLinksOf(data: ListingPageData): ListingSubLink[] {
  const { path, tree, listed } = data;
  if (path === null) {
    return [
      { id: "all", name: "All", href: PRODUCTS_PATH, current: true },
      ...tree
        .filter((entry) => entry.parentId === null && listed.has(entry.id))
        .map((main) => ({
          id: main.id,
          name: main.name,
          href: categoryListingPath([main]),
          current: false,
        })),
    ];
  }
  const main = path.path[0];
  if (!main) return [];
  const siblings = (
    path.path.length === 1
      ? path.children
      : tree.filter((entry) => entry.parentId === main.id)
  ).filter((child) => listed.has(child.id) || child.id === path.category.id);
  return [
    {
      id: "all",
      name: "All",
      href: categoryListingPath([main]),
      current: path.path.length === 1,
    },
    ...siblings.map((child) => ({
      id: child.id,
      name: child.name,
      href: categoryListingPath([main, child]),
      current: child.id === path.category.id,
    })),
  ];
}

const container = "mx-auto w-full max-w-(--container-site) px-4 md:px-8";

export default async function ProductsListingPage(
  props: PageProps<"/products/[[...category]]">,
) {
  const data = await loadFromProps(props);
  if (!data || isPastEnd(data)) notFound();

  const cloudName = siteCloudName();
  const heading = headingOf(data);
  const steps = data.path?.path ?? [];

  return (
    <div
      data-slot="listing-page"
      className={`${container} pt-4 pb-24 md:pt-6 md:pb-32`}
    >
      <ListingHeader
        title={heading}
        description={
          data.path ? (data.category?.description ?? null) : ROOT_DESCRIPTION
        }
        cover={coverOf(data.category, cloudName)}
        breadcrumb={
          steps.length > 0 ? (
            <ProductBreadcrumb
              categories={steps.slice(0, -1)}
              current={heading}
            />
          ) : null
        }
        subLinks={subLinksOf(data)}
        subLinksLabel={
          data.path ? `${steps[0]?.name ?? heading} categories` : "Categories"
        }
      />
      <div className="mt-8 md:mt-10">
        <ListingResults
          basePath={data.basePath}
          result={data.result}
          facets={data.facets}
          cards={toListingCards(data.result.cards, cloudName)}
          emptyScope={
            data.path
              ? {
                  message:
                    "Products for this category are on their way. Browse the full catalog in the meantime.",
                  href: PRODUCTS_PATH,
                  linkLabel: "All products",
                }
              : {
                  message:
                    "The catalog is being prepared. Please check back soon.",
                  href: "/",
                  linkLabel: "Home",
                }
          }
        />
      </div>
    </div>
  );
}
