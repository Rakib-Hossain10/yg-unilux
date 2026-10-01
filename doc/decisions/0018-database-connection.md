# 0018 — Database connection: one client, strict Mongoose, explicit indexes
- Status: Accepted
- Date: 2026-10-01

## Context
Mongoose and Better Auth's MongoDB adapter must share one connection pool (ADR 0017). The app runs on Vercel serverless functions, and must build with no secrets set (ADR 0011).

## Decision
- **One `MongoClient`, created by us** in `src/lib/db.ts` and cached on `globalThis` (this survives dev hot reloads and is reused by warm instances).
  - `getMongoClient()` / `getDb()` hand it out synchronously, with no network I/O; the driver connects on its first operation. Better Auth can therefore be given the client at module init.
  - `connectDb()` connects it once (concurrent callers share one attempt; a failed attempt clears the cache so the next call retries), then binds Mongoose with `mongoose.connection.setClient(client)`.
  - A stray `mongoose.connect()` that would open a second pool is refused.
- **Pool options for serverless:** `maxPoolSize 10`, `minPoolSize 0`, `maxIdleTimeMS 30 s`, `serverSelectionTimeoutMS 5 s` (fail fast), `connectTimeoutMS 10 s`, `socketTimeoutMS 30 s`, `appName yg-unilux`. Revisit them with Atlas metrics after launch.
- **Mongoose is strict:**
  - `strictQuery: "throw"`: a filter on an unknown path throws, instead of silently matching everything.
  - `bufferCommands: false`: a query run without a connection fails at once.
  - `autoIndex: false` and `autoCreate: false` in every environment.
  - Model files import `mongoose` from `@/lib/db` so these settings apply before any schema is built.
- **Indexes are built explicitly,** never on cold start: a `scripts/sync-indexes.ts` (Phase 1 task 2) calls `createIndexes()` for every model. It also creates the indexes Better Auth's collections need, because no migration runs for MongoDB. DB tests call `createIndexes()` themselves.
- **`MONGODB_URI` must name the database** (`…mongodb.net/yg_unilux?…`). `env.ts` rejects a URI without one, because the driver would silently use a database called `test`. Use different database names (or clusters) for Preview and Production.
- **`sanitizeFilter` stays off,** because it would rewrite our own `$gte`-style filters. Untrusted input is stopped by Zod at the boundary plus `strictQuery: "throw"`.
- **Errors are redacted.** `DbConnectionError` strips credentials and URIs from driver messages and keeps no `cause`. Nothing is logged.

## Consequences
- **Every data function and Better Auth call path awaits `connectDb()` first.** After a failed first connect, the driver fails fast until `connect()` runs again.
- **Tests:** Better Auth's adapter uses transactions when given `client`, so tests that use it need `MongoMemoryReplSet`, or `transaction: false` in the test configuration (task 5).
- **CI** caches the in-memory MongoDB binary (`~/.cache/mongodb-binaries`), because its postinstall download is blocked.
- **Open (Phase 10, Vercel):** under Fluid compute, idle timers don't run while an instance is suspended. Check the current Vercel docs for `attachDatabasePool(client)` from `@vercel/functions`, and decide `waitQueueTimeoutMS` after a load test.
