// Playwright's web server: starts an in-memory MongoDB replica set, seeds the
// e2e admin and customer through our real code (seedAdmin, Better Auth), then
// runs `next start` against it with test-only secrets. Nothing real is touched.

/*
 * Run by playwright.config.ts after `npm run build`:
 *   node --conditions=react-server --import tsx e2e/test-server.ts
 * (same node flags as the CLI scripts; see scripts/sync-indexes.ts). The
 * MongoDB binary is downloaded on first use, like the Vitest suite.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import process from "node:process";

import { MongoMemoryReplSet } from "mongodb-memory-server";

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";

const PORT = "3000";

// Fresh secrets per run: they only have to be valid, never stable.
const testEnv = {
  AUTH_SECRET: randomBytes(32).toString("base64url"),
  IP_HASH_SECRET: randomBytes(32).toString("base64url"),
  AUTH_URL: `http://localhost:${PORT}`,
  // The geo-block e2e tests send a fake country header (ADR 0026).
  GEO_BLOCK_ENABLED: "true",
};

async function seed(uri: string): Promise<void> {
  Object.assign(process.env, testEnv, { MONGODB_URI: uri });
  // Imported only after MONGODB_URI is set; they read env lazily anyway.
  const { connectDb, disconnectDb, getDb } = await import("@/lib/db");
  const { syncBetterAuthIndexes, syncIndexes } =
    await import("@/lib/db-indexes");
  const { indexedModels } = await import("@/models");
  const { createAuth } = await import("@/lib/auth");
  const { seedAdmin } = await import("@/lib/seed-admin");

  await connectDb();
  try {
    await syncIndexes(indexedModels);
    await syncBetterAuthIndexes(getDb());
    const auth = createAuth({ runInBackground: () => undefined });
    await seedAdmin(auth, { mode: "create", ...E2E_ADMIN });
    // A customer straight from createUser keeps mustChangePassword: true,
    // like a real new account; /admin must still answer 403.
    await auth.api.createUser({ body: { ...E2E_CUSTOMER } });
  } finally {
    await disconnectDb();
  }
}

async function main(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri("yg_e2e");
  await seed(uri);

  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "start", "-p", PORT],
    {
      stdio: "inherit",
      env: { ...process.env, ...testEnv, MONGODB_URI: uri },
    },
  );

  // Stop Next and MongoDB together, whichever way the run ends.
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    child.kill();
    await replSet.stop();
    process.exit(code);
  };
  child.on("exit", (code) => void stop(code ?? 0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void stop(0));
  }
}

main().catch((error: unknown) => {
  console.error(
    `e2e test server failed: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"}`,
  );
  process.exit(1);
});
