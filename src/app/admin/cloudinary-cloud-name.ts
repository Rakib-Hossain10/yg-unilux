// The Cloudinary cloud name for admin image previews, read on the server and
// passed to client components as a prop (never a public env variable). The
// cloud name is public: it is part of every res.cloudinary.com image URL.

import "server-only";

import { env, EnvError } from "@/lib/env";

/**
 * The configured cloud name, or null when Cloudinary is not set up (local
 * dev, CI). Then the editors show "Preview unavailable" and uploads fail at
 * the sign step with the server's own message. Only the cloud name leaves
 * this function; the API key and secret are dropped here.
 */
export function adminCloudName(): string | null {
  try {
    return env.cloudinary().cloudName;
  } catch (error) {
    if (error instanceof EnvError) return null;
    throw error;
  }
}
