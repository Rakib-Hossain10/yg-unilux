// QA harness (Phase 4a gate A): runs the REAL Next.js 16 `unstable_cache`,
// `updateTag` and `revalidateTag` against a real IncrementalCache with the
// file-system cache handler (memory store, no disk), the same classes
// `next start` uses for the data cache on a single instance. Nothing in
// next/cache is mocked. Only the request plumbing is faked: a minimal work
// store so `updateTag` sees "a Server Action" (or "a Route Handler" for
// `revalidateTag`), and `executeRevalidates` applies the tags the way Next
// does at the end of an action/request.
//
// What it does NOT model: the full-route (ISR HTML) cache, Vercel's shared
// data cache across instances, CDN. Those belong to gate B / a deploy smoke.

import "./next-als";

import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { IncrementalCache } from "next/dist/server/lib/incremental-cache";
import { tagsManifest } from "next/dist/server/lib/incremental-cache/tags-manifest.external";
import { nodeFs } from "next/dist/server/lib/node-fs-methods";
import { executeRevalidates } from "next/dist/server/revalidation-utils";

/* Next's built-in "max" profile (config-shared.js defaultConfig.cacheLife). */
const CACHE_LIFE_PROFILES = {
  max: {
    stale: 60 * 5,
    revalidate: 60 * 60 * 24 * 30,
    expire: 60 * 60 * 24 * 365,
  },
  default: { stale: 60 * 5, revalidate: 60 * 15, expire: 4294967294 },
};

export interface NextCacheHarness {
  cache: IncrementalCache;
  /** Runs `fn` as a Server Action would (updateTag allowed), then applies the tags. */
  inServerAction<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Runs `fn` as a Route Handler would (updateTag throws), then applies the tags. */
  inRouteHandler<T>(fn: () => T | Promise<T>): Promise<T>;
  /**
   * Runs `fn` inside a request-like work store (the path a page render takes:
   * stale entries are SERVED and refreshed in the background), then awaits
   * the background refreshes like Next does after the response.
   */
  inRequest<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Resets the tag manifest and the memory store (call in beforeEach). */
  reset(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Next's WorkStore has ~40 internal fields; the harness fills only what these code paths read.
type LooseStore = any;

function workStore(cache: IncrementalCache, page: string): LooseStore {
  return {
    page,
    route: page.replace(/\/(page|route)$/, "") || "/",
    incrementalCache: cache,
    cacheLifeProfiles: CACHE_LIFE_PROFILES,
    isStaticGeneration: false,
    isDraftMode: false,
    isOnDemandRevalidate: false,
    fetchCache: undefined,
    pendingRevalidatedTags: [],
    pendingRevalidates: {},
    pendingRevalidateWrites: [],
    nextFetchId: 1,
  };
}

let generation = 0;

function newCache(): IncrementalCache {
  // The handler's memory LRU is a process-wide singleton, so isolation comes
  // from a fresh key prefix per reset (it is part of every cache key).
  generation += 1;
  return new IncrementalCache({
    fs: nodeFs,
    dev: false,
    flushToDisk: false,
    minimalMode: false,
    serverDistDir: "/nonexistent-qa-harness",
    requestHeaders: {},
    maxMemoryCacheSize: 50 * 1024 * 1024,
    fetchCacheKeyPrefix: `qa-${generation}`,
    getPrerenderManifest: () => ({
      version: 4,
      routes: {},
      dynamicRoutes: {},
      notFoundRoutes: [],
      preview: {
        previewModeId: "qa-harness",
        previewModeSigningKey: "",
        previewModeEncryptionKey: "",
      },
    }),
  } as unknown as ConstructorParameters<typeof IncrementalCache>[0]);
}

export function createNextCacheHarness(): NextCacheHarness {
  const harness: NextCacheHarness = {
    cache: newCache(),
    reset() {
      tagsManifest.clear();
      harness.cache = newCache();
      (globalThis as { __incrementalCache?: unknown }).__incrementalCache =
        harness.cache;
    },
    async inServerAction(fn) {
      const store = workStore(harness.cache, "/admin/qa/page");
      const result = await workAsyncStorage.run(store, fn);
      await executeRevalidates(store);
      return result;
    },
    async inRouteHandler(fn) {
      const store = workStore(harness.cache, "/api/qa/route");
      const result = await workAsyncStorage.run(store, fn);
      await executeRevalidates(store);
      return result;
    },
    async inRequest(fn) {
      const store = workStore(harness.cache, "/product/[slug]/page");
      const result = await workAsyncStorage.run(store, fn);
      await executeRevalidates(store);
      return result;
    },
  };
  harness.reset();
  return harness;
}

/*
 * Next compares a tag's expiry with an entry's write time in whole
 * milliseconds and needs expiry > write time, so a write and an expiry in the
 * same millisecond look "not expired". Real requests are never that close;
 * tests step past it.
 */
export const nextTick = (ms = 5) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
