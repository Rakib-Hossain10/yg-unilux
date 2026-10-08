// Public product and area images on the site: the Cloudinary cloud name (read
// on the server, never a public env variable) and the plain delivery URL that
// next/image optimises. The cloud name is public; key and secret never leave.

import "server-only";

import { env, EnvError } from "@/lib/env";

/** The cloud name, or null when Cloudinary is not configured (dev, CI). */
export function siteCloudName(): string | null {
  try {
    return env.cloudinary().cloudName;
  } catch (error) {
    if (error instanceof EnvError) return null;
    throw error;
  }
}

/**
 * The untransformed delivery URL of a public image, or null without a cloud
 * name. next/image resizes it (remotePatterns are pinned to our cloud, ADR
 * 0016), so no Cloudinary transformation is put in the URL unless a
 * fixed one from CLOUDINARY_TRANSFORMS is asked for (smart crops).
 */
export function cloudinaryImageUrl(
  cloudName: string | null,
  publicId: string,
  transformation?: CloudinaryTransformation,
): string | null {
  if (!cloudName || publicId === "") return null;
  const path = publicId.split("/").map(encodeURIComponent).join("/");
  const step = transformation ? `${transformation}/` : "";
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/image/upload/${step}${path}`;
}

/*
 * The few fixed transformations the site asks Cloudinary for (a closed list,
 * never built from input). next/image still resizes the result.
 * - categoryCover: smart crop to the listing header's 3:2 frame (ADR 0067).
 *   No format step: next/image already serves AVIF/WebP, and this helper
 *   never asks for an automatic format (an icon could be an SVG original;
 *   static QA check in test/listing-gate-a-l3.qa.test.ts).
 */
export const CLOUDINARY_TRANSFORMS = {
  categoryCover: "c_fill,g_auto,ar_3:2,w_2400,q_auto",
} as const;
export type CloudinaryTransformation =
  (typeof CLOUDINARY_TRANSFORMS)[keyof typeof CLOUDINARY_TRANSFORMS];
