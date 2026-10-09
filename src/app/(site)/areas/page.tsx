// /areas: the application areas as black-and-white tiles (Phase 4b L5,
// Viabizzuno reference). The list comes from the cached area list (tag
// `areas`), never a hard-coded one. Rendered on request (`connection()`):
// CI builds with no database, so the page cannot be prerendered at build
// time; the data itself is cached, so a request costs no query.

import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";

import { AreaTiles } from "@/components/site/areas/area-tiles";
import {
  cloudinaryImageUrl,
  siteCloudName,
} from "@/components/site/cloudinary-image";
import { ListingHeader } from "@/components/site/listing/listing-header";
import {
  AREAS_PATH,
  areaListingPath,
  PRODUCTS_PATH,
} from "@/components/site/listing/listing-urls";
import { absoluteSiteUrl } from "@/components/site/site-url";
import { listPublicAreas } from "@/lib/catalog/areas";

const TITLE = "Applications";
const DESCRIPTION =
  "Lighting by the space it serves. Choose an application to see every YG UniLUX product made for it.";

export function generateMetadata(): Metadata {
  const canonical = absoluteSiteUrl(AREAS_PATH);
  return {
    title: TITLE,
    description: DESCRIPTION,
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: {
      type: "website",
      siteName: "YG UniLUX",
      title: TITLE,
      description: DESCRIPTION,
      ...(canonical ? { url: canonical } : {}),
    },
  };
}

const container = "mx-auto w-full max-w-(--container-site) px-4 md:px-8";

export default async function AreasPage() {
  await connection();
  const areas = await listPublicAreas();
  const cloudName = siteCloudName();

  return (
    <div
      data-slot="areas-page"
      className={`${container} pt-4 pb-24 md:pt-6 md:pb-32`}
    >
      <ListingHeader
        title={TITLE}
        description={DESCRIPTION}
        cover={null}
        subLinks={[]}
        subLinksLabel={TITLE}
      />
      <div className="mt-10 md:mt-16">
        {areas.length > 0 ? (
          <AreaTiles
            areas={areas.map((area) => ({
              id: area.id,
              name: area.name,
              href: areaListingPath(area),
              image: area.bwImage
                ? cloudinaryImageUrl(cloudName, area.bwImage)
                : null,
            }))}
          />
        ) : (
          <div
            data-slot="listing-empty"
            className="border-t border-ink py-12 md:py-16"
          >
            <p className="font-display text-3xl font-light text-balance md:text-4xl">
              Nothing here yet
            </p>
            <p className="mt-3 max-w-md text-grey-600">
              Applications are being prepared. Browse the full catalog in the
              meantime.
            </p>
            <Link
              href={PRODUCTS_PATH}
              className="mt-8 inline-flex h-11 items-center border border-ink px-6 text-sm transition-colors duration-(--duration-quick) hover:bg-ink hover:text-paper"
            >
              All products
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
