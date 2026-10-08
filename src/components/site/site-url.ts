// The public site's absolute origin (SITE_URL) for canonical links, JSON-LD
// and the sitemap. Server-only: env is read through src/lib/env.ts. Without
// SITE_URL (local dev, CI) pages simply leave absolute URLs out.

import "server-only";

import { env, EnvError } from "@/lib/env";

/** The configured site origin, or null when SITE_URL is not set. */
export function siteOrigin(): URL | null {
  try {
    return env.siteUrl();
  } catch (error) {
    if (error instanceof EnvError) return null;
    throw error;
  }
}

/** `path` (starting with "/") on the site origin, or null without SITE_URL. */
export function absoluteSiteUrl(path: string): string | null {
  const origin = siteOrigin();
  return origin ? new URL(path, origin).href : null;
}
