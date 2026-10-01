// The app's single MongoDB connection. Mongoose (our models) and Better Auth's
// MongoDB adapter share ONE driver MongoClient and so ONE connection pool
// (ADR 0017). Importing this file never reads env or opens a connection.

import "server-only";

import { type Db, MongoClient, type MongoClientOptions } from "mongodb";
import mongoose from "mongoose";

import { env } from "./env";

/*
 * Design: we create the MongoClient ourselves and hand it to Mongoose with
 * `connection.setClient()` (Mongoose 9.10.3, types/connection.d.ts:259).
 *
 * Why not `mongoose.connect()` + `connection.getClient()`: with that, the
 * client only exists once a connect has started, so Better Auth (built in
 * task 5) could not be given the client synchronously. Creating the client
 * ourselves lets `getMongoClient()` hand out the real client at any time
 * WITHOUT touching the network: the driver connects on its first operation
 * (mongodb 7.6 autoConnect), and `connectDb()` connects it explicitly.
 *
 * `setClient()` requires a client that has already connected and a Mongoose
 * connection that is still disconnected, so `connectDb()` connects first and
 * binds second. This works only because there is one `mongodb` copy shared
 * with Mongoose (setClient checks `instanceof MongoClient`;
 * test/deps/mongodb-driver.test.ts guards that).
 */

/*
 * Pool and timeout options, tuned for Vercel Functions talking to Atlas.
 * Values passed here take precedence over the same option in the URI.
 * Assumptions (no traffic data yet): a read-heavy catalog whose public pages
 * are mostly served from the Next.js cache, short OLTP queries, an Atlas
 * replica set, and Vercel Fluid compute (one instance may serve several
 * requests at once). Revisit with Atlas metrics (connections.current) after
 * launch.
 */
const CLIENT_OPTIONS = {
  // Shown in Atlas logs and the profiler, so our connections are identifiable.
  appName: "yg-unilux",
  // Per instance. Small, because every warm function instance has its own
  // pool and Atlas tiers cap total connections (M0: 500), but above 3–5 so
  // one instance can run a page's parallel queries plus Better Auth's.
  maxPoolSize: 10,
  // No pre-warmed connections: an idle or frozen instance should hold none.
  minPoolSize: 0,
  // Close connections idle for 30 s so instances between bursts release them.
  maxIdleTimeMS: 30_000,
  // Fail in 5 s (driver default: 30 s) when the cluster is unreachable, the
  // URI host is wrong or our IP is not allow-listed, instead of hanging the
  // request until the function times out.
  serverSelectionTimeoutMS: 5_000,
  // TCP + TLS handshake limit for a new pooled connection (default 30 s);
  // well above the normal Vercel-to-Atlas round trip.
  connectTimeoutMS: 10_000,
  // Close a socket whose operation has been silent for 30 s (default: never),
  // so a hung query cannot hold a pool slot forever. Our queries are short.
  socketTimeoutMS: 30_000,
} satisfies MongoClientOptions;

/*
 * Mongoose settings, applied when this module is imported (in-memory config
 * only: no env, no network). Model files must import `mongoose` from here so
 * these are set before any Schema is built: strictQuery is copied into each
 * schema when it is created.
 */
// A filter on a path that is not in the schema throws. `true` would silently
// drop the unknown key, turning a typo into "match every document".
mongoose.set("strictQuery", "throw");
// Never queue queries while disconnected (the default waits up to 10 s and
// then fails anyway). Every data function awaits connectDb() first, so a
// query that runs without a connection is a bug and should fail at once.
mongoose.set("bufferCommands", false);
// No automatic createCollection/createIndex when a model is compiled. On
// serverless that would re-run on every cold start, and with buffering off it
// would fail for models compiled before the connection opens. Indexes are
// built explicitly instead (Model.createIndexes() / a sync-indexes script).
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

export { mongoose };

/** A connection problem, with any credentials removed from the message. */
export class DbConnectionError extends Error {
  override readonly name = "DbConnectionError";

  // The original error is deliberately not kept as `cause`: driver errors can
  // carry the parsed URI or topology details that a logger would print.
  constructor(action: string, error: unknown) {
    const original = error instanceof Error ? error : new Error(String(error));
    super(
      `MongoDB: ${action} (${original.name}): ${redactCredentials(original.message)}`,
    );
  }
}

/*
 * Removes anything that looks like a connection string or a `user:pass@`
 * part from an error message. Probing the driver showed its messages contain
 * hosts but not credentials; this is defence in depth for messages we have
 * not seen.
 */
function redactCredentials(message: string): string {
  return message
    .replace(/mongodb(?:\+srv)?:\/\/\S*/gi, "mongodb://[redacted]")
    .replace(/[^\s/@:]+:[^\s/@]*@/g, "[redacted]@");
}

interface DbCache {
  /** The one MongoClient. Created on first use, kept across failed connects. */
  client: MongoClient | undefined;
  /** The in-flight or finished connect, shared by concurrent callers. */
  connection: Promise<typeof mongoose> | undefined;
}

/*
 * The cache lives on globalThis, not in a module variable: Next.js dev hot
 * reload re-evaluates this module, and a module variable would then open a
 * new pool on every edit. On Vercel, warm invocations reuse it either way.
 */
const CACHE_KEY = "__ygUniluxDb";

function dbCache(): DbCache {
  const store = globalThis as typeof globalThis & {
    [CACHE_KEY]?: DbCache;
  };
  store[CACHE_KEY] ??= { client: undefined, connection: undefined };
  return store[CACHE_KEY];
}

/**
 * The shared MongoClient, created on first call. No network I/O happens here:
 * the driver connects on the first operation, or when connectDb() runs.
 * Throws EnvError if MONGODB_URI is missing, DbConnectionError if the driver
 * rejects it.
 */
export function getMongoClient(): MongoClient {
  const cache = dbCache();
  if (!cache.client) {
    const { uri } = env.mongo();
    try {
      cache.client = new MongoClient(uri, CLIENT_OPTIONS);
    } catch (error) {
      throw new DbConnectionError("invalid MONGODB_URI", error);
    }
  }
  return cache.client;
}

/**
 * The database named in MONGODB_URI, on the shared client. This is the `Db`
 * Better Auth's `mongodbAdapter(db, { client })` needs; Mongoose uses the same.
 */
export function getDb(): Db {
  return getMongoClient().db();
}

/**
 * Connects the shared client (once) and binds Mongoose's default connection to
 * it. Await this before any Mongoose query. Concurrent callers share one
 * in-flight attempt; a failed attempt is forgotten so the next call retries.
 */
export function connectDb(): Promise<typeof mongoose> {
  const cache = dbCache();
  if (!cache.connection) {
    const attempt = openConnection();
    cache.connection = attempt;
    // Reset on failure. Callers still receive the rejection through `attempt`;
    // this branch only clears the cache (and keeps it from being unhandled).
    attempt.catch(() => {
      if (cache.connection === attempt) cache.connection = undefined;
    });
  }
  return cache.connection;
}

/* Connects the shared client, then points Mongoose at it. */
async function openConnection(): Promise<typeof mongoose> {
  const client = getMongoClient();
  try {
    // Safe to retry on the same client: after a failed attempt the driver
    // builds a fresh topology on the next connect().
    await client.connect();
  } catch (error) {
    throw new DbConnectionError("could not connect", error);
  }
  bindMongoose(client);
  return mongoose;
}

/* Binds Mongoose's default connection to our client, once. */
function bindMongoose(client: MongoClient): void {
  const connection = mongoose.connection;
  if (connection.getClient() === client) return;
  if (connection.readyState !== mongoose.ConnectionStates.disconnected) {
    // Someone opened Mongoose's default connection some other way (for
    // example mongoose.connect()); two pools would break ADR 0017.
    throw new Error(
      "Mongoose's default connection is already open on another client. Use connectDb() from src/lib/db.ts only.",
    );
  }
  connection.setClient(client);
}

/**
 * Closes the shared client and clears the cache. For CLI scripts (so the
 * process can exit) and tests only; the app never calls it. A client handed
 * out earlier (e.g. to Better Auth) is closed too and must not be reused.
 */
export async function disconnectDb(): Promise<void> {
  const cache = dbCache();
  const { client, connection } = cache;
  cache.client = undefined;
  cache.connection = undefined;

  // Let an in-flight connect settle so we don't close a client mid-handshake.
  if (connection) await Promise.allSettled([connection]);
  if (!client) return;
  // Closing Mongoose's connection also clears each model's cached init().
  if (mongoose.connection.getClient() === client) {
    await mongoose.connection.close();
  }
  await client.close();
}
