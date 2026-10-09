// /sitemap.xml: the home page, the catalog listings (/products, category
// paths with a published product, /areas and each area page) and every
// published product page, from cached reads (ADR 0063, 0065). URLs and
// last-change dates only, never a spec value or a filtered URL (rule 9).

import type { MetadataRoute } from "next";

import { catalogSitemapPaths } from "@/components/site/sitemap-paths";
import { listPublicAreas } from "@/lib/catalog/areas";
import { listPublicCategories } from "@/lib/catalog/categories";
import { listPublishedCategoryCounts } from "@/lib/catalog/category-counts";
import { listPublishedSlugs } from "@/lib/catalog/product";
import { env } from "@/lib/env";

/*
 * Not prerendered: CI builds have no database, and a build-time sitemap
 * would not follow later publishes. The reads behind it are cached anyway.
 * SITE_URL is required here (sitemaps need absolute URLs); unset, the route
 * fails loudly instead of serving wrong or empty URLs.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = env.siteUrl();
  const [products, tree, counts, areas] = await Promise.all([
    listPublishedSlugs(),
    listPublicCategories(),
    listPublishedCategoryCounts(),
    listPublicAreas(),
  ]);
  return [
    { url: new URL("/", origin).href },
    ...catalogSitemapPaths(tree, counts, areas).map((path) => ({
      url: new URL(path, origin).href,
    })),
    ...products.map((product) => ({
      url: new URL(`/product/${product.slug}`, origin).href,
      ...(product.updatedAt ? { lastModified: product.updatedAt } : {}),
    })),
  ];
}
