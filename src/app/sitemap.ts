// /sitemap.xml: published product pages only, from the cached slug list
// (ADR 0063). URLs and last-change dates, never a spec value (rule 9).
// Rendered per request; the slug list itself is cached on the `products` tag.

import type { MetadataRoute } from "next";

import { listPublishedSlugs } from "@/lib/catalog/product";
import { env } from "@/lib/env";

/*
 * Not prerendered: CI builds have no database, and a build-time sitemap
 * would not follow later publishes. The read behind it is cached anyway.
 * SITE_URL is required here (sitemaps need absolute URLs); unset, the route
 * fails loudly instead of serving wrong or empty URLs.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = env.siteUrl();
  const products = await listPublishedSlugs();
  return products.map((product) => ({
    url: new URL(`/product/${product.slug}`, origin).href,
    ...(product.updatedAt ? { lastModified: product.updatedAt } : {}),
  }));
}
