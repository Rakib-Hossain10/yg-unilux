// /product/[slug]: the public product page (Phase 4a, ADR 0054/0062/0063).
// Static (ISR) from the cached public view: restricted columns are never in
// it; the dynamic restricted block (P7) fills the reserved slots on the client.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import {
  siteCloudName,
  cloudinaryImageUrl,
} from "@/components/site/cloudinary-image";
import { ApplicationsRow } from "@/components/site/product/applications-row";
import { ProductBreadcrumb } from "@/components/site/product/breadcrumb";
import { Downloads } from "@/components/site/product/downloads";
import { GalleryStage } from "@/components/site/product/gallery-stage";
import { ModelsTable } from "@/components/site/product/models-table";
import {
  displayVariant,
  extraSpecGroups,
  metaDescription,
  productTitle,
  specTableGroups,
  displaySpecs,
} from "@/components/site/product/product-display";
import {
  productJsonLd,
  serializeJsonLd,
} from "@/components/site/product/product-json-ld";
import {
  ProductStrip,
  type StripCard,
} from "@/components/site/product/product-strip";
import { QuickSpecPanel } from "@/components/site/product/quick-spec-panel";
import { RestrictedSpecsSlot } from "@/components/site/product/restricted-slots";
import {
  SpecTable,
  type SpecTableGroup,
} from "@/components/site/product/spec-table";
import { absoluteSiteUrl } from "@/components/site/site-url";
import { getBreadcrumb } from "@/lib/catalog/categories";
import { getFamilyProducts } from "@/lib/catalog/family";
import { getPublicProduct, listPublishedSlugs } from "@/lib/catalog/product";
import { getRelatedProducts } from "@/lib/catalog/related";
import type { ProductCardView, PublicProductView } from "@/lib/catalog/view";
import { EnvError } from "@/lib/env";

/*
 * Never import @/lib/catalog/restricted here or in any component of this page
 * (static guard, ADR 0063). Never read headers()/cookies()/searchParams: the
 * page would turn dynamic and lose its static HTML (ADR 0062). The selected
 * variant (?model=) is read on the client by the P5 switcher.
 */

/** One read per render, shared by generateMetadata and the page. */
const loadProduct = cache((slug: string): Promise<PublicProductView | null> =>
  getPublicProduct(slug),
);

/**
 * Every published product is prerendered. Without a database (CI builds run
 * with no env, ADR 0062) the list is empty and pages render on first visit.
 */
export async function generateStaticParams(): Promise<{ slug: string }[]> {
  try {
    return (await listPublishedSlugs()).map(({ slug }) => ({ slug }));
  } catch (error) {
    if (error instanceof EnvError) return [];
    throw error;
  }
}

const canonicalPath = (slug: string) => `/product/${slug}`;

function imageAlt(
  product: PublicProductView,
  alt: string | null,
  index: number,
  total: number,
): string {
  return alt?.trim() || `${product.name}, image ${index + 1} of ${total}`;
}

/** Gallery images with absolute URLs; empty without a cloud name. */
function stageImages(product: PublicProductView, cloudName: string | null) {
  // Photos first, drawings after (plan "Gallery spec").
  const ordered = [
    ...product.images.filter((image) => image.kind === "gallery"),
    ...product.images.filter((image) => image.kind !== "gallery"),
  ];
  return ordered.flatMap((image, index) => {
    const src = cloudinaryImageUrl(cloudName, image.publicId);
    if (!src) return [];
    const alt = imageAlt(product, image.alt, index, ordered.length);
    return [{ src, alt: image.kind === "gallery" ? alt : `${alt} (drawing)` }];
  });
}

function toStripCards(
  cards: readonly ProductCardView[],
  cloudName: string | null,
): StripCard[] {
  return cards.map((card) => {
    const src = card.image
      ? cloudinaryImageUrl(cloudName, card.image.publicId)
      : null;
    return {
      id: card.id,
      href: `/product/${card.slug}`,
      name: card.name,
      modelCode: card.modelCode,
      // The card's name follows as text, so the picture's alt stays empty
      // unless the admin wrote one (no repeated announcement).
      image: src ? { src, alt: card.image?.alt?.trim() ?? "" } : null,
    };
  });
}

export async function generateMetadata({
  params,
}: PageProps<"/product/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await loadProduct(slug);
  if (!product) return { title: "Product not found", robots: { index: false } };

  const title = productTitle(product);
  const description = metaDescription(product);
  const canonical = absoluteSiteUrl(canonicalPath(product.slug));
  const ogImage = stageImages(product, siteCloudName())[0];
  return {
    title,
    description,
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: {
      type: "website",
      siteName: "YG UniLUX",
      title,
      description,
      ...(canonical ? { url: canonical } : {}),
      ...(ogImage ? { images: [{ url: ogImage.src, alt: ogImage.alt }] } : {}),
    },
  };
}

const container = "mx-auto w-full max-w-(--container-site) px-4 md:px-8";

export default async function ProductPage({
  params,
}: PageProps<"/product/[slug]">) {
  const { slug } = await params;
  const product = await loadProduct(slug);
  if (!product) notFound();

  const [categories, family, related] = await Promise.all([
    getBreadcrumb(product),
    getFamilyProducts(product.family, product.id),
    getRelatedProducts(product),
  ]);

  const cloudName = siteCloudName();
  const images = stageImages(product, cloudName);
  const title = productTitle(product);
  const variant = displayVariant(product);
  const shownModel = variant?.modelNo ?? product.modelCode ?? title;

  const groups: SpecTableGroup[] = [
    ...specTableGroups(displaySpecs(product)),
    ...extraSpecGroups(product.extraSpecs).map((group) => ({
      title: group.title,
      rows: group.rows.map((row, index) => ({
        key: `extra-${group.title}-${index}`,
        label: row.label,
        values: [row.value],
      })),
    })),
  ];

  const jsonLd = productJsonLd(
    product,
    images.map((image) => image.src),
    absoluteSiteUrl(canonicalPath(product.slug)),
  );

  return (
    <article
      data-product-id={product.id}
      className="product-page pt-4 pb-24 md:pt-6"
    >
      {/* A plain text child: React writes script text raw (no entity
          escaping), and serializeJsonLd escapes "<" so it cannot close the
          element. No raw-HTML prop is needed (QA static guard). */}
      <script type="application/ld+json">{serializeJsonLd(jsonLd)}</script>

      <div className={container}>
        <ProductBreadcrumb categories={categories} current={product.name} />
      </div>

      <div
        className={`${container} mt-4 grid gap-10 lg:grid-cols-12 lg:gap-16`}
      >
        <div className="lg:col-span-7">
          <GalleryStage images={images} productName={product.name} />
        </div>
        <div className="lg:col-span-5">
          <QuickSpecPanel product={product} />
        </div>
      </div>

      <div className={`${container} mt-16 space-y-16 md:mt-28 md:space-y-28`}>
        <SpecTable
          groups={groups}
          captionPrefix={`Specifications of ${product.name} ${shownModel}`}
        >
          {/* P7 renders restricted rows here for allowed viewers. */}
          <RestrictedSpecsSlot />
        </SpecTable>

        <ModelsTable variants={product.variants} productTitle={title} />

        <Downloads files={product.publicFiles} />

        <ApplicationsRow
          areas={product.areas.map((area) => ({
            id: area.id,
            name: area.name,
            href: `/areas/${area.slug}`,
            image: area.bwImage
              ? cloudinaryImageUrl(cloudName, area.bwImage)
              : null,
          }))}
        />

        {product.family ? (
          <ProductStrip
            id="family"
            title={`More from ${product.family}`}
            cards={toStripCards(family, cloudName)}
          />
        ) : null}

        <ProductStrip
          id="related"
          title="Related products"
          cards={toStripCards(related, cloudName)}
        />
      </div>
    </article>
  );
}
