// Vitest global setup: downloads the MongoDB binary once, in the main
// process, before any test worker starts. Otherwise parallel workers on a
// cold cache (a fresh CI runner) race for the same download lockfile and one
// fails with UnableToUnlockLockfileError.

import { MongoBinary } from "mongodb-memory-server";

export default async function setup(): Promise<void> {
  // Returns at once when the binary is already cached.
  await MongoBinary.getPath();
}
