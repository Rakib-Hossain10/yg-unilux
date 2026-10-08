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
import { SectionReveal } from "@/components/motion/product/section-reveal";
import { ApplicationsRow } from "@/components/site/product/applications-row";
import { ProductBreadcrumb } from "@/components/site/product/breadcrumb";
import { Downloads } from "@/components/site/product/downloads";
import { galleryImages } from "@/components/site/product/gallery-images";
import { GalleryStage } from "@/components/site/product/gallery-stage";
import { ModelsTable } from "@/components/site/product/models-table";
import {
  ProductDetailClient,
  SelectedModelNo,
  VariantSpecValues,
} from "@/components/site/product/product-detail-client";
import {
  extraSpecGroups,
  metaDescription,
  productTitle,
  specTableGroups,
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
import { RestrictedDataProvider } from "@/components/site/product/restricted-block";
import { RestrictedSpecsSlot } from "@/components/site/product/restricted-slots";
import {
  SpecTable,
  type SpecTableGroup,
} from "@/components/site/product/spec-table";
import {
  unionVariantSpecs,
  type SwitchVariant,
} from "@/components/site/product/variant-selection";
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
 * variant (?model=) is read on the client by ProductDetailClient (P5).
 */

/**
 * The variants the switcher works on: the product's own, or (a product saved
 * without one) a single stand-in holding the product's values. The fields
 * are copied one by one so nothing else of the view reaches the client.
 */
function switchVariants(product: PublicProductView): SwitchVariant[] {
  if (product.variants.length === 0) {
    return [
      {
        modelNo: product.modelCode ?? "",
        label: null,
        imagePublicId: null,
        specs: product.specs,
      },
    ];
  }
  return product.variants.map((variant) => ({
    modelNo: variant.modelNo,
    label: variant.label,
    imagePublicId: variant.imagePublicId,
    specs: variant.specs,
  }));
}

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

/** Gallery images (photos, then drawings); empty without a cloud name. */
function stageImages(product: PublicProductView, cloudName: string | null) {
  return galleryImages(product.images, product.name, (publicId) =>
    cloudinaryImageUrl(cloudName, publicId),
  );
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
      image:
        src && card.image
          ? { src, alt: card.image.alt?.trim() ?? "", kind: card.image.kind }
          : null,
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
  const variants = switchVariants(product);
  const shownModel = variants[0]?.modelNo ? <SelectedModelNo /> : title;

  // Every table column any variant fills; the cell follows the selection,
  // so a switch never adds or removes a row (no layout jump).
  const groups: SpecTableGroup[] = [
    ...specTableGroups(unionVariantSpecs(variants, product.specs)).map(
      (group) => ({
        title: group.title,
        rows: group.rows.map((row) => ({
          key: row.key,
          label: row.label,
          content: <VariantSpecValues specKey={row.key} size="compact" />,
        })),
      }),
    ),
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

      {/* The one client state of the page (selected variant, P5): panel,
          table and Models rows stay Server Components with client leaves. */}
      <ProductDetailClient variants={variants}>
        {/* Fetches this viewer's restricted answer after hydration (P7):
            only the product id crosses into it, never a restricted value. */}
        <RestrictedDataProvider productId={product.id}>
          <div
            className={`${container} mt-4 grid gap-10 lg:grid-cols-12 lg:gap-16`}
          >
            <div className="lg:col-span-7">
              <GalleryStage
                images={images}
                productName={product.name}
                productId={product.id}
              />
            </div>
            <div className="lg:col-span-5">
              <QuickSpecPanel product={product} variants={variants} />
            </div>
          </div>

          <div
            className={`${container} mt-16 space-y-16 md:mt-28 md:space-y-28`}
          >
            <SpecTable
              groups={groups}
              captionPrefix={
                <>
                  Specifications of {product.name} {shownModel}
                </>
              }
            >
              {/* Restricted rows for allowed viewers, filled on the client. */}
              <RestrictedSpecsSlot />
            </SpecTable>

            <ModelsTable variants={product.variants} productTitle={title} />
          </div>
          {/* Motion pass (P8): spec groups and Models rise in once; renders
              nothing and only marks sections below the fold after hydration. */}
          <SectionReveal />
        </RestrictedDataProvider>
      </ProductDetailClient>

      <div className={`${container} mt-16 space-y-16 md:mt-28 md:space-y-28`}>
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
