import type { NextConfig } from "next";

import {
  CLOUDINARY_URL_FORMAT,
  parseCloudinaryUrl,
} from "./src/lib/cloudinary-url";
import {
  WHISTLEBLOWER_HEADERS,
  securityHeaders,
} from "./src/lib/security-headers";

/**
 * next/image may optimise remote images only from our own Cloudinary cloud
 * (https://res.cloudinary.com/<cloud_name>/...), so /_next/image can't be used
 * to resize images from any other Cloudinary account at our cost.
 *
 * The cloud name comes from CLOUDINARY_URL. Without it (CI, a fresh checkout)
 * no remote images are allowed, which is fine because nothing renders them.
 * A set but malformed value fails the build instead of silently allowing nothing.
 */
function cloudinaryImagePatterns(): NonNullable<
  NonNullable<NextConfig["images"]>["remotePatterns"]
> {
  const raw = process.env.CLOUDINARY_URL;
  if (raw === undefined || raw === "") return [];

  const credentials = parseCloudinaryUrl(raw);
  if (!credentials) {
    // Never include the value: it contains the API secret.
    throw new Error(
      `CLOUDINARY_URL is invalid. Expected ${CLOUDINARY_URL_FORMAT}.`,
    );
  }

  return [
    {
      protocol: "https",
      hostname: "res.cloudinary.com",
      pathname: `/${credentials.cloudName}/**`,
    },
  ];
}

const nextConfig: NextConfig = {
  images: {
    remotePatterns: cloudinaryImagePatterns(),
    // AVIF first, WebP fallback (ADR 0011; installed docs: image.md "formats").
    formats: ["image/avif", "image/webp"],
  },
  // `next dev` would otherwise append a managed block to CLAUDE.md when it
  // detects an AI agent. CLAUDE.md is maintained by hand in this repo.
  agentRules: false,
  // Do not advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  experimental: {
    // Enables forbidden()/unauthorized() from next/navigation, so a signed-in
    // non-admin gets a real 403 from requireAdmin() (ADR 0024).
    authInterrupts: true,
  },
  // Security headers on every response (ADR 0027). The proxy's own CN 403
  // page sets its own (src/lib/geo.ts), because these don't reach it.
  async headers() {
    const isDev = process.env.NODE_ENV === "development";
    return [
      {
        source: "/:path*",
        // Inline scripts must stay allowed: the App Router streams its page
        // data in inline <script> tags whose content (and hash) differs per
        // page, and nonces would force every page to render per request,
        // losing the catalog cache (ADR 0008). Tested in task 9: SRI covers
        // only external files and hydration fails without this.
        headers: securityHeaders({ isDev, allowInlineScripts: true }),
      },
      // Later entries override earlier ones with the same header key.
      { source: "/whistleblower/:path*", headers: WHISTLEBLOWER_HEADERS },
      { source: "/whistleblower", headers: WHISTLEBLOWER_HEADERS },
    ];
  },
};

export default nextConfig;
