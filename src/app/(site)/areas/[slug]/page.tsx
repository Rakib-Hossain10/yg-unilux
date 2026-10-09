// /areas/<slug>: the products made for one application area (Phase 4b L5,
// plan Q4, ADR 0065). The area's black-and-white photo heads the page as a
// full-bleed band (AreaBand, Viabizzuno); the
// main-category facet (`cat`) sits on top of the spec facets; grid,
// pagination, metadata and robots rules are the /products ones. Rendered on
// request (it reads searchParams) from cached data. Cards and facets hold no
// spec value, so nothing restricted can reach the HTML.

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  CLOUDINARY_TRANSFORMS,
  cloudinaryImageUrl,
  siteCloudName,
} from "@/components/site/cloudinary-image";
import { AreaBand } from "@/components/site/areas/area-band";
import { ListingSubNav } from "@/components/site/listing/listing-header";
import {
  listingLoader,
  readListing,
  type ListingRead,
} from "@/components/site/listing/listing-load";
import { listingMetaTitle } from "@/components/site/listing/listing-meta";
import { ListingResults } from "@/components/site/listing/listing-results";
import {
  AREAS_PATH,
  areaListingPath,
  isRefinedListing,
  listingCanonicalPath,
  PRODUCTS_PATH,
} from "@/components/site/listing/listing-urls";
import { toListingCards } from "@/components/site/listing/listing-view";
import { ProductBreadcrumb } from "@/components/site/product/breadcrumb";
import { absoluteSiteUrl } from "@/components/site/site-url";
import { getAreaBySlug, listPublicAreas } from "@/lib/catalog/areas";
import { listPublicCategories } from "@/lib/catalog/categories";
import { getCatalogVisibility } from "@/lib/catalog/listing";
import type { PublicAreaView } from "@/lib/catalog/view";

/*
 * Never import @/lib/catalog/restricted, the session or next/headers here or
 * in any listing component (static guard in test/area-pages.test.ts).
 */

interface AreaPageData extends ListingRead {
  area: PublicAreaView;
  areas: PublicAreaView[];
  basePath: string;
  /** Main-category slug → name, for the `cat` chips. */
  categoryNames: Map<string, string>;
}

const ROOT = { name: "Applications", href: AREAS_PATH } as const;

/**
 * Everything an area page needs, once per request: null for an unknown or
 * malformed slug. The page answers 404 for null and for a page past the end.
 */
const loadArea = listingLoader(
  async (slug, queryKey): Promise<AreaPageData | null> => {
    const [area, areas, tree, visibility] = await Promise.all([
      getAreaBySlug(slug),
      listPublicAreas(),
      listPublicCategories(),
      getCatalogVisibility(),
    ]);
    if (area === null) return null;
    const { result, facets } = await readListing(
      { kind: "area", areaId: area.id },
      queryKey,
      visibility,
      { track: false, cat: true },
    );
    return {
      area,
      areas,
      basePath: areaListingPath(area),
      categoryNames: new Map(
        tree
          .filter((entry) => entry.parentId === null)
          .map((main) => [main.slug, main.name]),
      ),
      result,
      facets,
    };
  },
);

async function loadFromProps(
  props: PageProps<"/areas/[slug]">,
): Promise<AreaPageData | null> {
  const [{ slug }, query] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  return loadArea(slug, query);
}

/** Page 2+ of a listing that has fewer pages is not a page. */
const isPastEnd = (data: AreaPageData) =>
  data.result.page > data.result.pageCount;

/** The share image: the bw photo smart-cropped to 3:2, or null. */
function shareImageOf(
  area: PublicAreaView,
  cloudName: string | null,
): string | null {
  if (!area.bwImage) return null;
  return cloudinaryImageUrl(
    cloudName,
    area.bwImage,
    CLOUDINARY_TRANSFORMS.categoryCover,
  );
}

export async function generateMetadata(
  props: PageProps<"/areas/[slug]">,
): Promise<Metadata> {
  const data = await loadFromProps(props);
  if (!data || isPastEnd(data)) {
    return { title: "Page not found", robots: { index: false } };
  }
  const title = listingMetaTitle(
    [ROOT, data.area],
    ROOT.name,
    data.result.page,
  );
  const description = `${data.area.name} lighting in the YG UniLUX catalog: every product made for this application, by category and specification.`;
  const canonical = absoluteSiteUrl(
    listingCanonicalPath(data.basePath, data.result.page),
  );
  const shareImage = shareImageOf(data.area, siteCloudName());
  return {
    title,
    description,
    ...(canonical ? { alternates: { canonical } } : {}),
    // Any filter (the category too) or a non-default sort: not indexed,
    // links followed.
    ...(isRefinedListing(data.result.params)
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      type: "website",
      siteName: "YG UniLUX",
      title,
      description,
      ...(canonical ? { url: canonical } : {}),
      ...(shareImage ? { images: [{ url: shareImage }] } : {}),
    },
  };
}

const container = "mx-auto w-full max-w-(--container-site) px-4 md:px-8";

export default async function AreaPage(props: PageProps<"/areas/[slug]">) {
  const data = await loadFromProps(props);
  if (!data || isPastEnd(data)) notFound();

  const cloudName = siteCloudName();
  const { area } = data;

  return (
    <div data-slot="listing-page" className="pb-24 md:pb-32">
      <div className={`${container} pt-4 pb-4 md:pt-6`}>
        <ProductBreadcrumb root={ROOT} categories={[]} current={area.name} />
      </div>
      {/* Full-bleed: outside the container. The original photo (uncropped)
          so the band can frame it at any ratio. */}
      <AreaBand
        title={area.name}
        image={
          area.bwImage ? cloudinaryImageUrl(cloudName, area.bwImage) : null
        }
      />
      <div className={container}>
        <ListingSubNav
          links={data.areas.map((entry) => ({
            id: entry.id,
            name: entry.name,
            href: areaListingPath(entry),
            current: entry.id === area.id,
          }))}
          label="Applications"
          className="mt-6 md:mt-8"
        />
        <div className="mt-8 md:mt-10">
          <ListingResults
            basePath={data.basePath}
            result={data.result}
            facets={data.facets}
            cards={toListingCards(data.result.cards, cloudName)}
            categoryNames={data.categoryNames}
            emptyScope={{
              message:
                "Products for this application are on their way. Browse the full catalog in the meantime.",
              href: PRODUCTS_PATH,
              linkLabel: "All products",
            }}
          />
        </div>
      </div>
    </div>
  );
}
