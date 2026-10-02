// Per-email rate limiting for login and password-reset requests (ADR 0004),
// stored as fixed-window counters in the `loginAttempts` collection. The
// per-IP limit is Better Auth's own (ADR 0017); nothing here ever sees an IP.

import "server-only";

import { createHmac, hkdfSync } from "node:crypto";

import { MongoServerError } from "mongodb";

import { LoginAttemptModel } from "@/models/login-attempt";

import { connectDb } from "./db";
import { env } from "./env";

/** How many attempts a key may make per fixed window. */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** 5 failed sign-ins per email per 15 minutes. */
export const LOGIN_EMAIL = {
  limit: 5,
  windowSeconds: 15 * 60,
} as const satisfies RateLimitRule;

/** 3 password-reset requests per email per 60 minutes. */
export const RESET_EMAIL = {
  limit: 3,
  windowSeconds: 60 * 60,
} as const satisfies RateLimitRule;

/** Namespaces keyed by an email address. Phase 8 adds "wb-case" (case number, never IP). */
export type EmailNamespace = "email-login" | "email-reset";

/*
 * A counter key: "<namespace>:<64 hex chars>". Branded so the limiter only
 * accepts keys built by emailKey(), never a raw email typed by mistake.
 */
export type RateLimitKey = string & { readonly __brand: "RateLimitKey" };

/** The outcome of a check or an attempt. */
export interface RateLimitResult {
  /** True if this attempt (consume) or the next attempt (checkLimit) may go ahead. */
  allowed: boolean;
  /** Attempts still allowed in the current window. */
  remaining: number;
  /** Seconds until the window resets; 0 when allowed. Use for a Retry-After header. */
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

const KEY_PATTERN = /^[a-z][a-z-]*:[0-9a-f]{64}$/;

/* RFC 5321 limit for a whole address; Better Auth's own validation is stricter. */
const MAX_EMAIL_LENGTH = 254;

/* Domain-separated HMAC key: HKDF-SHA256(AUTH_SECRET, info "yg-rate-limit-v1"). */
function rateLimitSubkey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.auth().secret, "", "yg-rate-limit-v1", 32),
  );
}

/**
 * Builds the counter key for an email: namespace + HMAC-SHA256 of the email,
 * so the collection never holds an address. Normalisation is trim + lowercase
 * only, so "  Jane@Example.com " and "jane@example.com" share one counter.
 * Keyed by a subkey derived from AUTH_SECRET (HKDF, label below), so the
 * secret Better Auth uses to sign sessions is never reused directly for a
 * second purpose. Rotating AUTH_SECRET resets every counter, which is
 * acceptable (they last at most an hour). Throws EnvError without AUTH_SECRET.
 * Callers must Zod-validate the email first (rule 8); the length cap here is
 * only a backstop so a huge body can't be hashed.
 */
export function emailKey(
  namespace: EmailNamespace,
  email: string,
): RateLimitKey {
  if (typeof email !== "string" || email.length > MAX_EMAIL_LENGTH) {
    throw new TypeError(
      "emailKey: email must be a string of at most 254 characters",
    );
  }
  const normalised = email.trim().toLowerCase();
  const digest = createHmac("sha256", rateLimitSubkey())
    .update(normalised)
    .digest("hex");
  return `${namespace}:${digest}` as RateLimitKey;
}

/* Rejects malformed keys and rules before anything touches the database. */
function assertValid(key: RateLimitKey, rule?: RateLimitRule): void {
  if (!KEY_PATTERN.test(key)) {
    // The key itself is deliberately not in the message.
    throw new TypeError("Invalid rate-limit key; build it with emailKey()");
  }
  if (
    rule &&
    !(
      Number.isInteger(rule.limit) &&
      rule.limit > 0 &&
      Number.isInteger(rule.windowSeconds) &&
      rule.windowSeconds > 0
    )
  ) {
    throw new TypeError(
      "Invalid rate-limit rule: limit and windowSeconds must be positive integers",
    );
  }
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

/* Seconds until `expiresAt`, at least 1 (we are still inside the window) and at most the window. */
function secondsUntil(expiresAt: Date, rule: RateLimitRule): number {
  const seconds = Math.ceil((expiresAt.getTime() - Date.now()) / 1000);
  return Math.min(Math.max(seconds, 1), rule.windowSeconds);
}

/* Turns a counter state into the public result. `count` includes the current attempt for consume. */
function toResult(
  count: number,
  expiresAt: Date,
  rule: RateLimitRule,
  allowed: boolean,
): RateLimitResult {
  return {
    allowed,
    remaining: Math.max(rule.limit - count, 0),
    retryAfterSeconds: allowed ? 0 : secondsUntil(expiresAt, rule),
  };
}

/**
 * Read-only: may one more attempt be made under this key? A counter whose
 * window has ended counts as empty even if the TTL monitor (which runs about
 * once a minute) has not deleted it yet. Uses the DB clock ($$NOW), the same
 * clock consume() uses, so the two never disagree about the window.
 * For display only (e.g. a Retry-After value), NEVER as a gate: checking here
 * and recording later lets N parallel requests all pass the check. Gate with
 * consume().
 */
export async function checkLimit(
  key: RateLimitKey,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  assertValid(key, rule);
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
 * The atomic step, as one update pipeline run by the server:
 * - stage 1 decides whether the window has ended: no counter yet (a fresh
 *   upsert has no expiresAt) or expiresAt <= $$NOW;
 * - stage 2 either starts a new window (count 1, expiresAt = now + window)
 *   or adds 1 to the count and keeps the window's end (fixed window);
 * - stage 3 drops the helper field.
 * Because the read-decide-write happens inside one findOneAndUpdate on one
 * document, concurrent attempts are serialised by MongoDB and each sees a
 * distinct count. Mongoose does not cast pipelines (hence updatePipeline).
 */
function incrementPipeline(rule: RateLimitRule) {
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
        count: { $cond: ["$_windowEnded", 1, { $add: ["$count", 1] }] },
        expiresAt: {
          $cond: [
            "$_windowEnded",
            { $add: ["$$NOW", rule.windowSeconds * 1000] },
            "$expiresAt",
          ],
        },
      },
    },
    { $unset: "_windowEnded" },
  ];
}

/* Runs the pipeline with upsert and returns the counter after the increment. */
function incrementOnce(key: RateLimitKey, rule: RateLimitRule) {
  return LoginAttemptModel.findOneAndUpdate({ key }, incrementPipeline(rule), {
    upsert: true,
    returnDocument: "after",
    updatePipeline: true,
    projection: { _id: 0, count: 1, expiresAt: 1 },
  })
    .lean()
    .exec();
}

/*
 * Two requests upserting a brand-new key at the same moment can both try to
 * insert; the unique index on `key` rejects the second with E11000. The
 * document now exists, so one retry simply increments it.
 */
async function increment(key: RateLimitKey, rule: RateLimitRule) {
  try {
    return await incrementOnce(key, rule);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) {
      return incrementOnce(key, rule);
    }
    throw error;
  }
}

/**
 * Counts one attempt and says whether it may go ahead, atomically: of N
 * parallel calls in one window exactly `rule.limit` are allowed. Attempts over
 * the limit still count but never extend the window. Recommended for both
 * hooks: consume before sign-in (and clearAttempts after a success), consume
 * before sending a reset email.
 */
export async function consume(
  key: RateLimitKey,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  assertValid(key, rule);
  const doc = await withDb("consume", () => increment(key, rule));
  if (!doc)
    throw new RateLimitUnavailableError(
      "consume",
      new Error("upsert returned no document"),
    );
  return toResult(doc.count, doc.expiresAt, rule, doc.count <= rule.limit);
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

/** Forgets a key's counter, e.g. after a successful sign-in. */
export async function clearAttempts(key: RateLimitKey): Promise<void> {
  assertValid(key);
  await withDb("clearAttempts", () =>
    LoginAttemptModel.deleteOne({ key }).exec(),
  );
}
