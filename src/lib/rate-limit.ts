// Rate-limit counters in the `loginAttempts` TTL collection (ADR 0004, 0020,
// 0022): fixed-window counters, a progressive slow-down counter, HMAC'd keys
// and clearing. Nothing here ever sees an IP; src/lib/sign-in-limit.ts does.

import "server-only";

import { createHmac, hkdfSync, randomUUID } from "node:crypto";

import { MongoServerError } from "mongodb";

import { LoginAttemptModel } from "@/models/login-attempt";

import { connectDb } from "./db";
import { env } from "./env";

/** How many attempts a key may make per fixed window. */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * A progressive slow-down: the first `freeAttempts` are immediate, then each
 * attempt must wait baseDelaySeconds * 2^(k - freeAttempts) after the
 * previous one (k = attempts so far), capped at maxDelaySeconds. The counter
 * resets after idleResetSeconds without an accepted attempt. Never a lockout.
 */
export interface SlowdownRule {
  readonly freeAttempts: number;
  readonly baseDelaySeconds: number;
  readonly maxDelaySeconds: number;
  readonly idleResetSeconds: number;
}

/*
 * Every key namespace in the collection (the rules live in sign-in-limit.ts):
 * - "email-login":     per-email sign-in slow-down;
 * - "email-ip-login":  per-(email + network) sign-in hard limit;
 * - "email-dev-login": per-(email + known device) sign-in hard limit;
 * - "email-reset":     per-email password-reset-request throttle (slow-down);
 * - "email-ip-reset":  per-(email + network) password-reset-request hard limit;
 * - "user-pw-change":  per-user /change-password hard limit (by user id);
 * - "ba-limit":        Better Auth's own per-network limiter (HMAC'd keys).
 * - "access-request-net":   public access-request form, per network (ADR 0069);
 * - "access-request-email": public access-request form, per email (ADR 0069);
 * - "invite-user":     admin invite (re)generation, per customer (ADR 0070);
 * - "invite-lock":     the in-flight lock of one customer's invite (ADR 0070);
 * - "download-user":   datasheet downloads per user, 60 per hour (ADR 0071);
 * - "cron-lock":       one run at a time of a cron job (expiry reminders,
 *                      ADR 0072), keyed by the SHA-256 of the job's name.
 * Phase 8 adds "wb-case" (keyed by case number, never by IP).
 */
export type KeyNamespace =
  | "email-login"
  | "email-ip-login"
  | "email-dev-login"
  | "email-reset"
  | "email-ip-reset"
  | "user-pw-change"
  | "ba-limit"
  | "access-request-net"
  | "access-request-email"
  | "invite-user"
  | "invite-lock"
  | "download-user"
  | "cron-lock";

/** Namespaces keyed by the email alone, which emailKey() builds. */
export type EmailNamespace = "email-reset" | "email-login";

/*
 * A counter key: "<namespace>:<64 hex>" or, for per-network counters,
 * "<namespace>:<64 hex email HMAC>.<64 hex network HMAC>". Branded so the
 * limiter only accepts keys built here, never a raw email or IP by mistake.
 */
export type RateLimitKey = string & { readonly __brand: "RateLimitKey" };

/** The outcome of a check or an attempt. */
export interface RateLimitResult {
  /** True if this attempt (consume) or the next attempt (checkLimit) may go ahead. */
  allowed: boolean;
  /** Attempts still allowed (fixed window) or still free of delay (slow-down). */
  remaining: number;
  /** Seconds to wait before trying again; 0 when allowed. Use for a Retry-After header. */
  retryAfterSeconds: number;
}

/**
 * The limiter's database is unreachable or a query failed. The caller must
 * refuse the request with a generic "try again later": failing open would
 * allow unlimited guesses, and failing into a lockout would let a DB hiccup
 * lock users out. No cause is attached and the message holds no key, because
 * driver errors (e.g. duplicate key) echo the key and loggers print causes.
 */
export class RateLimitUnavailableError extends Error {
  override readonly name = "RateLimitUnavailableError";

  constructor(operation: string, error: unknown) {
    const kind = error instanceof Error ? error.name : typeof error;
    super(`Rate limiter unavailable: ${operation} failed (${kind})`);
  }
}

const HEX_64 = /^[0-9a-f]{64}$/;
const KEY_PATTERN = /^[a-z][a-z-]*:[0-9a-f]{64}(\.[0-9a-f]{64})?$/;

/* RFC 5321 limit for a whole address; Better Auth's own validation is stricter. */
const MAX_EMAIL_LENGTH = 254;

/* Domain-separated HMAC key: HKDF-SHA256(AUTH_SECRET, info "yg-rate-limit-v1"). */
function rateLimitSubkey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.authSecret(), "", "yg-rate-limit-v1", 32),
  );
}

/**
 * HMAC-SHA256 of the normalised email (trim + lowercase), as 64 hex chars,
 * so the collection never holds an address. "  Jane@Example.com " and
 * "jane@example.com" give the same digest. Keyed by a subkey derived from
 * AUTH_SECRET (HKDF, label above), so the session-signing secret is never
 * reused directly. Rotating AUTH_SECRET resets every counter (they last at
 * most an hour). Throws EnvError without AUTH_SECRET. Callers must
 * Zod-validate the email first (rule 8); the length cap is only a backstop.
 */
export function hashEmail(email: string): string {
  if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH) {
    throw new TypeError(
      "hashEmail: email must be a string of at most 254 characters",
    );
  }
  return createHmac("sha256", rateLimitSubkey())
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/**
 * HMAC-SHA256 of a user id, as 64 hex chars, with the same subkey as
 * hashEmail(). The "user-id:" prefix keeps it apart from email digests, so
 * the collection never holds a raw id either.
 */
export function hashUserId(userId: string): string {
  if (typeof userId !== "string" || userId === "" || userId.length > 128) {
    throw new TypeError("hashUserId: userId must be 1-128 characters");
  }
  return createHmac("sha256", rateLimitSubkey())
    .update(`user-id:${userId}`)
    .digest("hex");
}

/**
 * Joins a namespace and one or two digests into a key. Only accepts 64-hex
 * digests (from hashEmail or another HMAC), so a raw email or IP can't slip in.
 */
export function buildKey(
  namespace: KeyNamespace,
  digest: string,
  networkDigest?: string,
): RateLimitKey {
  if (
    !HEX_64.test(digest) ||
    (networkDigest !== undefined && !HEX_64.test(networkDigest))
  ) {
    throw new TypeError("buildKey: digests must be 64 lowercase hex chars");
  }
  const key =
    networkDigest === undefined
      ? `${namespace}:${digest}`
      : `${namespace}:${digest}.${networkDigest}`;
  return key as RateLimitKey;
}

/** The counter key for an email in a fixed-window namespace. */
export function emailKey(
  namespace: EmailNamespace,
  email: string,
): RateLimitKey {
  return buildKey(namespace, hashEmail(email));
}

/* Rejects malformed keys and rules before anything touches the database. */
function assertKey(key: RateLimitKey): void {
  if (!KEY_PATTERN.test(key)) {
    // The key itself is deliberately not in the message.
    throw new TypeError("Invalid rate-limit key; build it with buildKey()");
  }
}

const isPositiveInt = (n: number) => Number.isInteger(n) && n > 0;

function assertRule(rule: RateLimitRule): void {
  if (!(isPositiveInt(rule.limit) && isPositiveInt(rule.windowSeconds))) {
    throw new TypeError(
      "Invalid rate-limit rule: limit and windowSeconds must be positive integers",
    );
  }
}

function assertSlowdown(rule: SlowdownRule): void {
  const ok =
    Number.isInteger(rule.freeAttempts) &&
    rule.freeAttempts >= 0 &&
    isPositiveInt(rule.baseDelaySeconds) &&
    isPositiveInt(rule.maxDelaySeconds) &&
    rule.maxDelaySeconds >= rule.baseDelaySeconds &&
    isPositiveInt(rule.idleResetSeconds) &&
    rule.idleResetSeconds >= rule.maxDelaySeconds;
  if (!ok) throw new TypeError("Invalid slow-down rule");
}

/* Runs a DB operation after connecting; any DB failure becomes RateLimitUnavailableError. */
async function withDb<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    await connectDb();
    return await run();
  } catch (error) {
    throw new RateLimitUnavailableError(operation, error);
  }
}

/*
 * Two requests upserting a brand-new key at the same moment can both try to
 * insert; the unique index on `key` rejects the second with E11000. The
 * document now exists, so one retry simply updates it.
 */
async function retryDuplicateOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return run();
    throw error;
  }
}

/* Whole seconds from now until `until`, clamped to [1, max]. */
function secondsUntil(until: Date, max: number): number {
  const seconds = Math.ceil((until.getTime() - Date.now()) / 1000);
  return Math.min(Math.max(seconds, 1), max);
}

/* Turns a fixed-window state into the public result. `count` includes the current attempt for consume. */
function toResult(
  count: number,
  expiresAt: Date,
  rule: RateLimitRule,
  allowed: boolean,
): RateLimitResult {
  return {
    allowed,
    remaining: Math.max(rule.limit - count, 0),
    retryAfterSeconds: allowed
      ? 0
      : secondsUntil(expiresAt, rule.windowSeconds),
  };
}

/**
 * Read-only: may one more attempt be made under this fixed-window key? A
 * counter whose window has ended counts as empty even if the TTL monitor
 * (about once a minute) has not deleted it yet. Uses the DB clock ($$NOW),
 * like consume(). For display only, NEVER as a gate: check-then-record lets
 * N parallel requests all pass (QA M1). Gate with consume().
 */
export async function checkLimit(
  key: RateLimitKey,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  assertKey(key);
  assertRule(rule);
  const doc = await withDb("checkLimit", () =>
    LoginAttemptModel.findOne(
      { key, $expr: { $gt: ["$expiresAt", "$$NOW"] } },
      { _id: 0, count: 1, expiresAt: 1 },
    )
      .lean()
      .exec(),
  );
  if (!doc)
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  return toResult(doc.count, doc.expiresAt, rule, doc.count < rule.limit);
}

/*
 * The fixed-window step, as one update pipeline run by the server:
 * - stage 1 decides whether the window has ended (no counter yet, as a fresh
 *   upsert has no expiresAt, or expiresAt <= $$NOW) and whether this attempt
 *   fits: a new window, or count still below the limit;
 * - stage 2 starts a new window (count 1, expiresAt = now + window) or, if
 *   the attempt fits, adds 1 and keeps the window's end (fixed window, so
 *   expiresAt is never later than window start + windowSeconds). A refused
 *   attempt changes no count, so the count never passes the limit and units
 *   refused attempts during a burst can't use up places (QA L1);
 *   lastAttemptAllowed records this attempt's decision for the caller;
 * - stage 3 drops the helper fields.
 * The read-decide-write happens inside one findOneAndUpdate on one document,
 * so concurrent attempts are serialised by MongoDB and each gets its own
 * decision. Mongoose does not cast pipelines (hence updatePipeline).
 */
function windowPipeline(rule: RateLimitRule) {
  return [
    {
      $set: {
        _windowEnded: {
          $or: [
            { $eq: [{ $type: "$expiresAt" }, "missing"] },
            { $lte: ["$expiresAt", "$$NOW"] },
          ],
        },
      },
    },
    {
      $set: {
        _fits: { $or: ["$_windowEnded", { $lt: ["$count", rule.limit] }] },
      },
    },
    {
      $set: {
        count: {
          $cond: [
            "$_windowEnded",
            1,
            { $cond: ["$_fits", { $add: ["$count", 1] }, "$count"] },
          ],
        },
        expiresAt: {
          $cond: [
            "$_windowEnded",
            { $add: ["$$NOW", rule.windowSeconds * 1000] },
            "$expiresAt",
          ],
        },
        lastAttemptAllowed: "$_fits",
      },
    },
    { $unset: ["_windowEnded", "_fits"] },
  ];
}

/**
 * Counts one attempt and decides atomically: of N parallel calls in one
 * window exactly `rule.limit` are allowed. Refused attempts change nothing
 * and never extend the window. Use it to gate before the sign-in or reset.
 */
export async function consume(
  key: RateLimitKey,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  assertKey(key);
  assertRule(rule);
  const doc = await withDb("consume", () =>
    retryDuplicateOnce(() =>
      LoginAttemptModel.findOneAndUpdate({ key }, windowPipeline(rule), {
        upsert: true,
        returnDocument: "after",
        updatePipeline: true,
        projection: { _id: 0, count: 1, expiresAt: 1, lastAttemptAllowed: 1 },
      })
        .lean()
        .exec(),
    ),
  );
  if (!doc || doc.lastAttemptAllowed === undefined)
    throw new RateLimitUnavailableError(
      "consume",
      new Error("upsert returned no decision"),
    );
  return toResult(doc.count, doc.expiresAt, rule, doc.lastAttemptAllowed);
}

/**
 * Counts one attempt without using the decision, e.g. to count an extra
 * failure. Same atomic update as consume(). Do not pair it with checkLimit()
 * as a gate (that is raceable); gate with consume() instead.
 */
export function recordAttempt(
  key: RateLimitKey,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  return consume(key, rule);
}

/*
 * The slow-down step, as one update pipeline (same atomicity argument as the
 * fixed window, DB clock $$NOW throughout):
 * - _fresh: no counter yet, or idle for idleResetSeconds (expiresAt passed);
 * - _open: fresh, still within the free attempts, or the wait set by the
 *   previous accepted attempt is over;
 * - open: count + 1, expiry = now + idle reset (sliding), and the wait
 *   before the next attempt = 0 while within the free attempts, else
 *   base * 2^(count - free) capped at max;
 * - closed: nothing changes except lastAttemptAllowed = false, so attempts
 *   during a wait never lengthen it and the wait can't pass the cap;
 * - helper fields are dropped.
 * The exponent is clamped so $pow never overflows on a very long attack.
 */
function slowdownPipeline(rule: SlowdownRule) {
  const newCount = { $add: ["$_count", 1] };
  const delayMs = {
    $cond: [
      { $lt: [newCount, rule.freeAttempts] },
      0,
      {
        $min: [
          {
            $multiply: [
              rule.baseDelaySeconds * 1000,
              {
                $pow: [
                  2,
                  { $min: [{ $subtract: [newCount, rule.freeAttempts] }, 30] },
                ],
              },
            ],
          },
          rule.maxDelaySeconds * 1000,
        ],
      },
    ],
  };
  return [
    {
      $set: {
        _fresh: {
          $or: [
            { $eq: [{ $type: "$expiresAt" }, "missing"] },
            { $lte: ["$expiresAt", "$$NOW"] },
          ],
        },
      },
    },
    {
      $set: {
        _count: { $cond: ["$_fresh", 0, "$count"] },
        _open: {
          $or: [
            "$_fresh",
            // Within the free attempts, open regardless of time: $$NOW is
            // fixed when an operation starts, so a concurrent one that
            // started a moment earlier would otherwise see a zero wait set
            // by a later one as still in the future.
            { $lt: ["$count", rule.freeAttempts] },
            { $eq: [{ $type: "$nextAllowedAt" }, "missing"] },
            { $lte: ["$nextAllowedAt", "$$NOW"] },
          ],
        },
      },
    },
    {
      $set: {
        count: { $cond: ["$_open", newCount, "$_count"] },
        lastAttemptAllowed: "$_open",
        expiresAt: {
          $cond: [
            "$_open",
            { $add: ["$$NOW", rule.idleResetSeconds * 1000] },
            "$expiresAt",
          ],
        },
        nextAllowedAt: {
          $cond: ["$_open", { $add: ["$$NOW", delayMs] }, "$nextAllowedAt"],
        },
      },
    },
    { $unset: ["_fresh", "_count", "_open"] },
  ];
}

/**
 * Counts one attempt against a slow-down key and decides atomically. Refused
 * attempts (still inside the wait) get the remaining wait (1..max seconds)
 * and change nothing, so no flood of attempts can lengthen the wait.
 */
export async function consumeSlowdown(
  key: RateLimitKey,
  rule: SlowdownRule,
): Promise<RateLimitResult> {
  assertKey(key);
  assertSlowdown(rule);
  const doc = await withDb("consumeSlowdown", () =>
    retryDuplicateOnce(() =>
      LoginAttemptModel.findOneAndUpdate({ key }, slowdownPipeline(rule), {
        upsert: true,
        returnDocument: "after",
        updatePipeline: true,
        projection: {
          _id: 0,
          count: 1,
          nextAllowedAt: 1,
          lastAttemptAllowed: 1,
        },
      })
        .lean()
        .exec(),
    ),
  );
  if (!doc?.nextAllowedAt || doc.lastAttemptAllowed === undefined)
    throw new RateLimitUnavailableError(
      "consumeSlowdown",
      new Error("upsert returned no slow-down state"),
    );
  const allowed = doc.lastAttemptAllowed;
  return {
    allowed,
    remaining: Math.max(rule.freeAttempts - doc.count, 0),
    retryAfterSeconds: allowed
      ? 0
      : secondsUntil(doc.nextAllowedAt, rule.maxDelaySeconds),
  };
}

/** Forgets the given counters, e.g. after a successful sign-in. */
export async function clearAttempts(...keys: RateLimitKey[]): Promise<void> {
  keys.forEach(assertKey);
  await withDb("clearAttempts", () =>
    LoginAttemptModel.deleteMany({ key: { $in: keys } }).exec(),
  );
}

/**
 * Forgets every counter of one email: the sign-in slow-down, the reset
 * throttle and ALL its per-network and per-device counters (anchored prefix
 * matches on "email-ip-login:<email HMAC>.", "email-dev-login:<email HMAC>."
 * and "email-ip-reset:<email HMAC>.", which can use the unique key index).
 * For the CLI admin reset (task 7) and after a successful password reset,
 * so the owner of the account always gets back in.
 */
export async function clearAllForEmail(email: string): Promise<void> {
  const digest = hashEmail(email);
  const exact = [
    buildKey("email-login", digest),
    buildKey("email-reset", digest),
  ];
  // The digest is hex, so it needs no regex escaping; only the "." does.
  const pairPrefix = new RegExp(
    `^email-(ip-login|dev-login|ip-reset):${digest}\\.`,
  );
  await withDb("clearAllForEmail", () =>
    LoginAttemptModel.deleteMany({
      $or: [{ key: { $in: exact } }, { key: { $regex: pairPrefix } }],
    }).exec(),
  );
}

/**
 * Takes a short lock under `key` (e.g. "one invite at a time for this
 * customer"). Returns an owner token when this caller now holds it, null
 * while someone else does. One update pipeline on the key's document (the
 * same atomic pattern as consume()): when no lock is held, or the held one
 * has ended by the DB clock ($$NOW), this caller's token and a new end are
 * written; otherwise nothing changes. The caller holds the lock exactly when
 * the returned document carries its token. A crashed holder's lock ends by
 * itself after `seconds`. Release with releaseLock(key, owner) in a
 * `finally`: only the owner's lock is removed, so a caller whose lock ran
 * out never frees someone else's.
 */
export async function acquireLock(
  key: RateLimitKey,
  seconds: number,
): Promise<string | null> {
  assertKey(key);
  if (!isPositiveInt(seconds)) throw new TypeError("Invalid lock duration");
  const owner = randomUUID();
  const pipeline = [
    {
      $set: {
        _free: {
          $or: [
            { $eq: [{ $type: "$expiresAt" }, "missing"] },
            { $lte: ["$expiresAt", "$$NOW"] },
          ],
        },
      },
    },
    {
      $set: {
        count: 1,
        owner: { $cond: ["$_free", owner, "$owner"] },
        expiresAt: {
          $cond: ["$_free", { $add: ["$$NOW", seconds * 1000] }, "$expiresAt"],
        },
      },
    },
    { $unset: ["_free"] },
  ];
  const doc = await withDb("acquireLock", () =>
    retryDuplicateOnce(() =>
      LoginAttemptModel.findOneAndUpdate({ key }, pipeline, {
        upsert: true,
        returnDocument: "after",
        updatePipeline: true,
        projection: { _id: 0, owner: 1 },
      })
        .lean()
        .exec(),
    ),
  );
  return doc?.owner === owner ? owner : null;
}

/** Releases a lock taken with acquireLock(), only while `owner` holds it. */
export async function releaseLock(
  key: RateLimitKey,
  owner: string,
): Promise<void> {
  assertKey(key);
  await withDb("releaseLock", () =>
    LoginAttemptModel.deleteOne({ key, owner }).exec(),
  );
}
