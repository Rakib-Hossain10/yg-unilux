// Where e2e/test-server.ts leaves the URI of its throwaway in-memory MongoDB,
// so a spec can add records no admin screen can make yet (e.g. a product that
// uses a category or area) and read state back. Never a real database.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MongoClient } from "mongodb";

/** Written by the test server once the replica set is seeded. */
export const E2E_MONGODB_URI_FILE = join(tmpdir(), "yg-e2e-mongodb-uri.txt");

/**
 * A driver connection to the e2e database. Refuses anything that is not a
 * local in-memory server, so a stray file can never point a spec at Atlas.
 */
export async function connectE2eDb(): Promise<MongoClient> {
  const uri = readFileSync(E2E_MONGODB_URI_FILE, "utf8").trim();
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri)) {
    throw new Error("The e2e database URI is not a local in-memory server");
  }
  return MongoClient.connect(uri);
}
