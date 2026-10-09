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
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MongoMemoryReplSet } from "mongodb-memory-server";

import { E2E_ADMIN, E2E_CUSTOMER } from "./fixtures/accounts";
import { seedAreaPages } from "./fixtures/area-pages";
import { E2E_MONGODB_URI_FILE } from "./fixtures/database";
import { seedListingGateB } from "./fixtures/listing-gate-b";
import { seedListingMotion } from "./fixtures/listing-motion";
import { seedListingPages } from "./fixtures/listing-pages";
import { seedProductPages } from "./fixtures/product-pages";
import {
  E2E_FAKE_PROVIDERS_PORT,
  E2E_PROVIDER_ENV,
} from "./fixtures/providers-port";
import { startFakeProviders } from "./fake-providers/server";

const PORT = "3000";

/*
 * Every variable named in .env.example starts out empty, so `next start`
 * never falls back to the developer's .env.local: @next/env keeps a variable
 * that is already in process.env, even an empty one, and env.ts reads "" as
 * unset. Real email, image, R2, whistleblower and cron secrets stay out
 * (rule 11). Read from the file so a new variable can't be missed.
 */
const blanks: Record<string, string> = Object.fromEntries(
  readFileSync(new URL("../.env.example", import.meta.url), "utf8")
    .split(/\r?\n/)
    .flatMap((line) => {
      const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      return name ? [[name, ""]] : [];
    }),
);

/* MONGODB_URI is added per run by main(), once the replica set exists. */
const testEnv = {
  ...blanks,
  // Fresh secrets per run: they only have to be valid, never stable.
  AUTH_SECRET: randomBytes(32).toString("base64url"),
  IP_HASH_SECRET: randomBytes(32).toString("base64url"),
  AUTH_URL: `http://localhost:${PORT}`,
  // Canonical URLs, JSON-LD urls and the sitemap need it (/sitemap.xml
  // answers 500 without it, ADR 0064).
  SITE_URL: `http://localhost:${PORT}`,
  // The geo-block e2e tests send a fake country header (ADR 0026).
  GEO_BLOCK_ENABLED: "true",
  // Fake provider credentials (also used for the build, see providers-port.ts).
  ...E2E_PROVIDER_ENV,
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
    // Every product-page spec's products, BEFORE `next start`: the cached
    // published-slug list fills on the first product-page visit, so a
    // product a spec inserted later would 404 (gate B harness fix).
    await seedProductPages(getDb());
    // The listing specs' categories and products, for the same reason: the
    // category tree is cached on the first catalog request.
    await seedListingPages(getDb());
    // The area-page spec's areas, categories and products (the area list
    // is cached on the first catalog request too).
    await seedAreaPages(getDb());
    // QA gate B (4b): every-column leak data for listing, search and menu.
    await seedListingGateB(getDb());
    // 4b L7: a category with a long CCT facet (listing motion spec).
    await seedListingMotion(getDb());
  } finally {
    await disconnectDb();
  }
}

/*
 * Next keeps two caches on disk that outlive a build and a restart: the data
 * cache (`unstable_cache` entries, e.g. the published-slug list) and the ISR
 * route cache (rendered product pages and their 404s). The fixtures use fixed
 * slugs, so an earlier run's page would be served (as STALE) on the first
 * request of this one. Both are dropped before `next start`; the webServer
 * command in playwright.config.ts also drops them before the build.
 */
function dropNextCaches(): void {
  for (const dir of [
    "../.next/cache/fetch-cache",
    "../.next/server/route-cache",
  ]) {
    rmSync(new URL(dir, import.meta.url), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  dropNextCaches();
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri("yg_e2e");
  await seed(uri);
  // Specs that need data no admin screen can make yet (a product using a
  // category or area) read the throwaway database's URI from here.
  writeFileSync(E2E_MONGODB_URI_FILE, uri, "utf8");

  // The R2 and Cloudinary fakes. The app's server reaches them only because
  // the preload below is added to ITS NODE_OPTIONS and E2E_FAKE_PROVIDERS_PORT
  // is set; neither exists anywhere but this file.
  const fakes = await startFakeProviders(E2E_FAKE_PROVIDERS_PORT);
  const preload = pathToFileURL(
    fileURLToPath(new URL("./fake-providers/preload.mjs", import.meta.url)),
  ).href;

  const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "start", "-p", PORT],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ...testEnv,
        MONGODB_URI: uri,
        E2E_FAKE_PROVIDERS_PORT: String(E2E_FAKE_PROVIDERS_PORT),
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim(),
      },
    },
  );

  // Stop Next and MongoDB together, whichever way the run ends.
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    child.kill();
    fakes.close();
    await replSet.stop();
    process.exit(code);
  };
  // A crash by signal has no exit code; it must still fail the run.
  child.on("exit", (code, signal) => void stop(code ?? (signal ? 1 : 0)));
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
