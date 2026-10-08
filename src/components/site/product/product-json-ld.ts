// schema.org structured data for a product page (plan "SEO"): Product, or a
// ProductGroup with one Product per variant (sku/mpn = model no.). Public
// view only; no price, no spec values at all, so no restricted value (rule 9).

import type { PublicProductView } from "@/lib/catalog/view";

import { metaDescription, productTitle } from "./product-display";

export const BRAND_NAME = "YG UniLUX";

type JsonLd = Record<string, unknown>;

/**
 * The JSON-LD object. `imageUrls` are absolute image URLs (may be empty),
 * `pageUrl` is the absolute canonical URL or null when SITE_URL is unset.
 */
export function productJsonLd(
  product: PublicProductView,
  imageUrls: readonly string[],
  pageUrl: string | null,
): JsonLd {
  const title = productTitle(product);
  const brand = { "@type": "Brand", name: BRAND_NAME };
  const common: JsonLd = {
    name: title,
    description: metaDescription(product),
    brand,
    ...(imageUrls.length > 0 ? { image: [...imageUrls] } : {}),
    ...(pageUrl ? { url: pageUrl } : {}),
  };

  if (product.variants.length <= 1) {
    const modelNo = product.variants[0]?.modelNo ?? product.modelCode;
    return {
      "@context": "https://schema.org",
      "@type": "Product",
      ...common,
      ...(modelNo ? { sku: modelNo, mpn: modelNo } : {}),
    };
  }

  return {
    "@context": "https://schema.org",
    "@type": "ProductGroup",
    ...common,
    productGroupID: product.modelCode ?? product.slug,
    hasVariant: product.variants.map((variant) => ({
      "@type": "Product",
      name: `${product.name} ${variant.modelNo}`,
      sku: variant.modelNo,
      mpn: variant.modelNo,
      brand,
    })),
  };
}

/**
 * The script body: JSON with "<" escaped so a stored string can never close
 * the script element (installed docs, 02-guides/json-ld.md).
 */
export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
