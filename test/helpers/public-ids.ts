// Test helper: Cloudinary public ids in the app's server-chosen shape
// (`yg/<folder>/<ownerId>/<uuid v4>`), deterministic so tests can compare them.

import { buildPublicId, type ImageUploadTarget } from "@/lib/cloudinary-ids";

/** A fixed owner id for tests that don't care which product or area it is. */
export const TEST_OWNER_ID = "0123456789abcdef01234567";

/** The n-th test UUID v4 (n from 0 to 4095). */
export function testUuid(n: number): string {
  const hex = n.toString(16).padStart(3, "0");
  return `00000000-0000-4000-8000-000000000${hex}`;
}

/** A valid public id for `ownerId`'s folder; `n` picks the UUID. */
export function testPublicId(
  n = 0,
  ownerId: string = TEST_OWNER_ID,
  target: ImageUploadTarget = "product",
): string {
  return buildPublicId(target, ownerId, testUuid(n));
}
