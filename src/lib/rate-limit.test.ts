// Tests for src/lib/rate-limit.ts: the fixed-window counter and key builders, run
// against a real in-memory MongoDB so the atomic update pipeline, the unique
// index race and the expiry handling are exercised for real.

import { MongoServerError } from "mongodb";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { getDb, mongoose } from "./db";
import { EnvError } from "./env";
import {
  type RateLimitKey,
  type RateLimitRule,
  RateLimitUnavailableError,
  buildKey,
  checkLimit,
  clearAttempts,
  consume,
  emailKey,
  hashEmail,
  hashUserId,
  recordAttempt,
} from "./rate-limit";

// A test-only secret (not a real one): 32+ characters, as env.auth() requires.
const TEST_SECRET = "test-secret-for-rate-limit-tests-0123456789";
const EMAIL = "jane.doe@example.com";

/* A 5-per-15-minutes fixed window, the shape of the sign-in hard limit. */
const FIVE_PER_15 = {
  limit: 5,
  windowSeconds: 15 * 60,
} as const satisfies RateLimitRule;

/* A 3-per-hour fixed window, the shape of the reset-request network limit. */
const THREE_PER_HOUR = {
  limit: 3,
  windowSeconds: 60 * 60,
} as const satisfies RateLimitRule;

setupMemoryDb("yg_rate_limit_test");

beforeAll(async () => {
  // The memory DB is created with autoIndex off (ADR 0018); the unique index
  // on `key` is what the duplicate-key retry relies on, so build it.
  await LoginAttemptModel.createIndexes();
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", TEST_SECRET);
  await LoginAttemptModel.deleteMany({});
});

/** Uses up `n` attempts on a key. */
async function consumeTimes(
  key: RateLimitKey,
  n: number,
  rule: RateLimitRule = FIVE_PER_15,
) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await consume(key, rule));
  return results;
}

describe("emailKey", () => {
  it("maps the same email in any case or surrounding whitespace to one key", () => {
    const key = emailKey("email-reset", EMAIL);
    expect(emailKey("email-reset", "  Jane.Doe@EXAMPLE.com\n")).toBe(key);
    expect(emailKey("email-reset", "john@example.com")).not.toBe(key);
  });

  it("is namespace + 64 hex chars and contains no part of the email", () => {
    const key = emailKey("email-reset", EMAIL);
    expect(key).toMatch(/^email-reset:[0-9a-f]{64}$/);
    expect(key).not.toContain("jane");
    expect(key).not.toContain("example");
  });

  it("changes when AUTH_SECRET changes (rotation only resets counters)", () => {
    const before = emailKey("email-reset", EMAIL);
    vi.stubEnv("AUTH_SECRET", `${TEST_SECRET}-rotated`);
    expect(emailKey("email-reset", EMAIL)).not.toBe(before);
  });

  it("throws EnvError when AUTH_SECRET is missing", () => {
    vi.stubEnv("AUTH_SECRET", undefined);
    expect(() => emailKey("email-reset", EMAIL)).toThrow(EnvError);
  });
});

describe("hashUserId", () => {
  const ID = "6702a1b2c3d4e5f6a7b8c9d0";

  it("is a stable 64-hex digest that holds no part of the id", () => {
    const digest = hashUserId(ID);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashUserId(ID)).toBe(digest);
    expect(digest).not.toContain(ID.slice(0, 8));
    expect(hashUserId(`${ID}x`)).not.toBe(digest);
  });

  it("is domain-separated from hashEmail for the same string", () => {
    expect(hashUserId(EMAIL)).not.toBe(hashEmail(EMAIL));
  });

  it("rejects an empty or oversized id", () => {
    expect(() => hashUserId("")).toThrow(TypeError);
    expect(() => hashUserId("a".repeat(129))).toThrow(TypeError);
  });
});

describe("consume", () => {
  it("allows exactly `limit` attempts, then refuses with the remaining window", async () => {
    const key = emailKey("email-reset", EMAIL);
    const results = await consumeTimes(key, 6);

    expect(results.map((r) => r.allowed)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0, 0]);
    expect(results.slice(0, 5).every((r) => r.retryAfterSeconds === 0)).toBe(
      true,
    );
    // Just started a 15-minute window: retry after ~900 s.
    expect(results[5]?.retryAfterSeconds).toBeGreaterThanOrEqual(898);
    expect(results[5]?.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it("reports retryAfterSeconds from the window's end, not from the last attempt", async () => {
    const key = emailKey("email-reset", EMAIL);
    await consumeTimes(key, 3, THREE_PER_HOUR);
    // Pretend the window started 50 minutes ago: 10 minutes are left.
    await LoginAttemptModel.updateOne(
      { key },
      { expiresAt: new Date(Date.now() + 600_000) },
    );

    const refused = await consume(key, THREE_PER_HOUR);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(598);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("does not extend the window with attempts over the limit", async () => {
    const key = emailKey("email-reset", EMAIL);
    await consumeTimes(key, 5);
    const end = (await LoginAttemptModel.findOne({ key }).lean())?.expiresAt;
    await consumeTimes(key, 3);
    expect(
      (await LoginAttemptModel.findOne({ key }).lean())?.expiresAt,
    ).toEqual(end);
  });

  it("starts a fresh window when expiresAt has passed but TTL has not deleted the doc yet", async () => {
    const key = emailKey("email-reset", EMAIL);
    await consumeTimes(key, 6);
    await LoginAttemptModel.updateOne(
      { key },
      { expiresAt: new Date(Date.now() - 1_000) },
    );

    expect(await checkLimit(key, FIVE_PER_15)).toEqual({
      allowed: true,
      remaining: 5,
      retryAfterSeconds: 0,
    });
    const fresh = await consume(key, FIVE_PER_15);
    expect(fresh).toEqual({
      allowed: true,
      remaining: 4,
      retryAfterSeconds: 0,
    });
    const doc = await LoginAttemptModel.findOne({ key }).lean();
    expect(doc?.count).toBe(1);
    expect(doc?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 890_000);
  });

  it("lets exactly `limit` of many parallel attempts on a new key through", async () => {
    const key = emailKey("email-reset", EMAIL);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => consume(key, FIVE_PER_15)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(FIVE_PER_15.limit);
    expect(await LoginAttemptModel.countDocuments({ key })).toBe(1);
    // Refused attempts change nothing, so the count stops at the limit.
    expect((await LoginAttemptModel.findOne({ key }).lean())?.count).toBe(
      FIVE_PER_15.limit,
    );
  });

  it("retries once when a concurrent upsert of the same new key wins the insert", async () => {
    const key = emailKey("email-reset", EMAIL);
    const duplicate = new MongoServerError({
      message: "E11000 duplicate key error",
      code: 11000,
    });
    const exec = vi
      .spyOn(mongoose.Query.prototype, "exec")
      .mockRejectedValueOnce(duplicate);

    expect(await consume(key, FIVE_PER_15)).toEqual({
      allowed: true,
      remaining: 4,
      retryAfterSeconds: 0,
    });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("rejects keys not built by emailKey, before touching the database", async () => {
    const exec = vi.spyOn(mongoose.Query.prototype, "exec");
    await expect(
      consume(`email-login:${EMAIL}` as RateLimitKey, FIVE_PER_15),
    ).rejects.toThrow(TypeError);
    await expect(
      consume(emailKey("email-reset", EMAIL), { limit: 0, windowSeconds: 60 }),
    ).rejects.toThrow(TypeError);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("checkLimit", () => {
  it("is read-only and agrees with consume", async () => {
    const key = emailKey("email-reset", EMAIL);
    expect(await checkLimit(key, FIVE_PER_15)).toEqual({
      allowed: true,
      remaining: 5,
      retryAfterSeconds: 0,
    });
    expect(await LoginAttemptModel.countDocuments({})).toBe(0);

    await consumeTimes(key, 4);
    expect(await checkLimit(key, FIVE_PER_15)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    await recordAttempt(key, FIVE_PER_15);

    const blocked = await checkLimit(key, FIVE_PER_15);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(898);
    expect((await LoginAttemptModel.findOne({ key }).lean())?.count).toBe(5);
  });
});

describe("clearAttempts", () => {
  it("resets a key so the full limit is available again", async () => {
    const key = emailKey("email-reset", EMAIL);
    await consumeTimes(key, 6);
    await clearAttempts(key);

    expect(await LoginAttemptModel.countDocuments({ key })).toBe(0);
    expect(await consume(key, FIVE_PER_15)).toMatchObject({
      allowed: true,
      remaining: 4,
    });
  });
});

describe("buildKey", () => {
  it("accepts only 64-hex digests, so a raw email or IP can't become a key", () => {
    const digest = hashEmail(EMAIL);
    expect(buildKey("email-ip-login", digest, "b".repeat(64))).toBe(
      `email-ip-login:${digest}.${"b".repeat(64)}`,
    );
    expect(() => buildKey("email-login", EMAIL)).toThrow(TypeError);
    expect(() => buildKey("email-ip-login", digest, "203.0.113.7")).toThrow(
      TypeError,
    );
  });
});

describe("namespaces and storage", () => {
  it("keeps counters in different namespaces independent for the same email", async () => {
    const login = buildKey("email-ip-login", hashEmail(EMAIL), "a".repeat(64));
    const reset = emailKey("email-reset", EMAIL);
    await consumeTimes(login, 6);

    expect(await consume(reset, THREE_PER_HOUR)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect((await checkLimit(login, FIVE_PER_15)).allowed).toBe(false);
  });

  it("never stores the email in the raw collection", async () => {
    await consume(emailKey("email-reset", EMAIL), FIVE_PER_15);
    await consume(
      emailKey("email-reset", "  JOHN.DOE@example.com "),
      THREE_PER_HOUR,
    );

    const raw = await getDb().collection("loginAttempts").find({}).toArray();
    expect(raw).toHaveLength(2);
    const stored = JSON.stringify(raw).toLowerCase();
    expect(stored).not.toContain("jane");
    expect(stored).not.toContain("john");
    expect(stored).not.toContain("example.com");
    expect(stored).not.toContain("@");
    // Only the schema's fields: no helper field left behind by the pipeline.
    for (const doc of raw) {
      expect(Object.keys(doc).sort()).toEqual([
        "_id",
        "count",
        "expiresAt",
        "key",
        "lastAttemptAllowed",
      ]);
    }
  });
});

describe("database failures", () => {
  it("turn into RateLimitUnavailableError without the key in the message", async () => {
    const key = emailKey("email-reset", EMAIL);
    const failure = new MongoServerError({
      message: `E11000 dup key: { key: "${key}" }`,
      code: 91,
    });
    vi.spyOn(mongoose.Query.prototype, "exec").mockRejectedValue(failure);

    for (const call of [
      () => consume(key, FIVE_PER_15),
      () => checkLimit(key, FIVE_PER_15),
      () => recordAttempt(key, FIVE_PER_15),
      () => clearAttempts(key),
    ]) {
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitUnavailableError);
      expect((error as Error).message).not.toContain(key.split(":")[1]);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("does not retry a duplicate-key error twice", async () => {
    const key = emailKey("email-reset", EMAIL);
    const duplicate = new MongoServerError({ message: "E11000", code: 11000 });
    vi.spyOn(mongoose.Query.prototype, "exec").mockRejectedValue(duplicate);

    await expect(consume(key, FIVE_PER_15)).rejects.toThrow(
      RateLimitUnavailableError,
    );
  });
});
