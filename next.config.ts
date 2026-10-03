import type { NextConfig } from "next";

import {
  CLOUDINARY_URL_FORMAT,
  parseCloudinaryUrl,
} from "./src/lib/cloudinary-url";

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
};

export default nextConfig;
