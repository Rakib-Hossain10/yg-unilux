// Test helper: starts one in-memory MongoDB for a test file and connects the
// app's shared connection (src/lib/db.ts) to it. Never touches a real
// database: MONGODB_URI is stubbed to the in-memory server before connecting.

import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, vi } from "vitest";

import { connectDb, disconnectDb } from "@/lib/db";

// First run on a machine downloads the MongoDB binary (can take minutes).
export const SERVER_START_TIMEOUT_MS = 600_000;

/**
 * Registers beforeAll/afterAll hooks for the calling test file. The returned
 * `uri()` gives the in-memory server's URI once the hooks have run.
 */
export function setupMemoryDb(dbName: string): { uri: () => string } {
  let server: MongoMemoryServer | undefined;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    // Only needed for the first connect; Vitest unstubs it before each test.
    vi.stubEnv("MONGODB_URI", server.getUri(dbName));
    await connectDb();
  }, SERVER_START_TIMEOUT_MS);

  afterAll(async () => {
    await disconnectDb();
    await server?.stop();
  });

  return {
    uri: () => {
      if (!server) throw new Error("memory server not started yet");
      return server.getUri(dbName);
    },
  };
}
