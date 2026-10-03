// QA tests that try to break src/lib/rate-limit.ts and sign-in-limit.ts:
// heavy concurrency on new and expired keys, normalisation parity with Better
// Auth (lowercase only, non-ASCII rejected), and key leakage.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  type RateLimitKey,
  type RateLimitRule,
  checkLimit,
  consume,
  emailKey,
} from "./rate-limit";
import {
  SIGN_IN_NETWORK,
  SIGN_IN_SLOWDOWN,
  consumeSignIn,
} from "./sign-in-limit";

const TEST_SECRET = "qa-only-secret-for-rate-limit-tests-abcdef";

/* A 3-per-hour fixed window, the shape of the reset-request network limit. */
const THREE_PER_HOUR = {
  limit: 3,
  windowSeconds: 60 * 60,
} as const satisfies RateLimitRule;

/* A 5-per-15-minutes fixed window, the shape of the sign-in hard limit. */
const FIVE_PER_15 = {
  limit: 5,
  windowSeconds: 15 * 60,
} as const satisfies RateLimitRule;

setupMemoryDb("yg_rate_limit_qa_test");

beforeAll(async () => {
  await LoginAttemptModel.createIndexes();
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", TEST_SECRET);
  await LoginAttemptModel.deleteMany({});
});

describe("concurrency", () => {
  it("lets exactly `limit` through per key when many new keys are hit in parallel", async () => {
    const keys = Array.from({ length: 10 }, (_, i) =>
      emailKey("email-reset", `user${i}@example.com`),
    );
    const results = await Promise.all(
      keys.flatMap((key) =>
        Array.from({ length: 40 }, () =>
          consume(key, FIVE_PER_15).then((r) => ({ key, r })),
        ),
      ),
    );

    for (const key of keys) {
      const mine = results.filter((x) => x.key === key);
      expect(mine.filter((x) => x.r.allowed)).toHaveLength(FIVE_PER_15.limit);
      // Every attempt saw a distinct count: remaining values 4..0 appear once each.
      expect(
        mine
          .map((x) => x.r.remaining)
          .filter((n) => n > 0)
          .sort((a, b) => a - b),
      ).toEqual([1, 2, 3, 4]);
    }
    expect(await LoginAttemptModel.countDocuments({})).toBe(keys.length);
    const counts = await LoginAttemptModel.find({}, { count: 1 }).lean();
    // Refused attempts don't count (QA L1): the count stops at the limit.
    expect(counts.every((d) => d.count === FIVE_PER_15.limit)).toBe(true);
  });

  it("resets an expired-but-not-deleted window exactly once under parallel load", async () => {
    const key = emailKey("email-reset", "victim@example.com");
    for (let i = 0; i < 4; i++) await consume(key, THREE_PER_HOUR);
    const old = new Date(Date.now() - 5_000);
    await LoginAttemptModel.updateOne({ key }, { expiresAt: old });

    const results = await Promise.all(
      Array.from({ length: 30 }, () => consume(key, THREE_PER_HOUR)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(THREE_PER_HOUR.limit);
    const doc = await LoginAttemptModel.findOne({ key }).lean();
    // One new window (refusals don't count, QA L1), not several overlapping
    // resets: those would have let more than `limit` through above.
    expect(doc?.count).toBe(THREE_PER_HOUR.limit);
    expect(doc?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
  });
});

// Extension for ADR 0022: the sign-in limiter's two keys under parallel load.
// Ten emails are attacked at once so operations really interleave, which is
// what exposed a $$NOW ordering race in the slow-down's free attempts.
describe("sign-in concurrency", () => {
  const emails = Array.from({ length: 10 }, (_, i) => `user${i}@example.com`);
  const signIn = (email: string, ip: string) =>
    consumeSignIn({
      email,
      headers: new Headers({ "x-vercel-forwarded-for": ip }),
    }).then((r) => ({ email, r }));

  beforeEach(() => {
    vi.stubEnv("IP_HASH_SECRET", "qa-only-ip-secret-for-rate-limit-tests-xyz");
  });

  it.each([1, 2, 3])(
    "round %i: exactly 5 per (email + network) when 10 emails x 40 attempts run in parallel",
    async () => {
      await LoginAttemptModel.deleteMany({});
      const results = await Promise.all(
        emails.flatMap((email) =>
          Array.from({ length: 40 }, () => signIn(email, "203.0.113.7")),
        ),
      );
      for (const email of emails) {
        const mine = results.filter((x) => x.email === email);
        expect(mine.filter((x) => x.r.allowed)).toHaveLength(
          SIGN_IN_NETWORK.limit,
        );
      }
    },
  );

  it.each([1, 2, 3])(
    "round %i: exactly 10 per email when 10 emails x 60 attempts over 20 networks run in parallel",
    async () => {
      await LoginAttemptModel.deleteMany({});
      const results = await Promise.all(
        emails.flatMap((email) =>
          Array.from({ length: 60 }, (_, i) =>
            signIn(email, `198.51.100.${1 + (i % 20)}`),
          ),
        ),
      );
      for (const email of emails) {
        const mine = results.filter((x) => x.email === email);
        expect(mine.filter((x) => x.r.allowed)).toHaveLength(
          SIGN_IN_SLOWDOWN.freeAttempts,
        );
      }
      // Every attempt that reached the slow-down keeps its network unit (no
      // give-back since the H1 decision): 60 per email, 3 per network.
      const units = await LoginAttemptModel.aggregate<{ total: number }>([
        { $match: { key: /^email-ip-login:/ } },
        { $group: { _id: null, total: { $sum: "$count" } } },
      ]);
      expect(units[0]?.total).toBe(emails.length * 60);
    },
  );
});

describe("normalisation parity with Better Auth 1.7.7", () => {
  // Better Auth's sign-in/reset routes validate with z.email() and look the
  // account up by email.toLowerCase(). Any address it accepts must map to
  // the same counter as its lowercase form, or case-variants would bypass us.
  const accepted = [
    "Jane.Doe@Example.COM",
    "JANE.DOE@EXAMPLE.COM",
    "jane.doe@example.com",
    "jAnE.dOe@eXaMpLe.CoM",
  ];

  it("maps every case variant Better Auth accepts to one key", () => {
    for (const e of accepted) expect(z.email().safeParse(e).success).toBe(true);
    const keys = new Set(accepted.map((e) => emailKey("email-reset", e)));
    expect(keys.size).toBe(1);
  });

  it("keeps addresses that are different accounts in Better Auth on different keys", () => {
    const a = emailKey("email-reset", "jane@example.com");
    expect(emailKey("email-reset", "jane+1@example.com")).not.toBe(a);
    expect(emailKey("email-reset", "jane@example.co")).not.toBe(a);
    expect(emailKey("email-reset", "jane.@example.com")).not.toBe(a);
  });

  it("only merges look-alike forms that Better Auth rejects anyway", () => {
    // Kelvin sign U+212A lowercases to ASCII "k": same counter (conservative),
    // and Better Auth's z.email() rejects it, so it never reaches an account.
    const kelvin = "Kate@example.com";
    expect(emailKey("email-reset", kelvin)).toBe(
      emailKey("email-reset", "kate@example.com"),
    );
    for (const e of [
      kelvin,
      " kate@example.com",
      "kate@example.com.",
      "katé@example.com",
    ]) {
      expect(z.email().safeParse(e).success).toBe(false);
    }
  });
});

describe("no key or email leakage", () => {
  it("an invalid key error names neither the email nor the key", async () => {
    const raw = "email-login:victim@example.com" as RateLimitKey;
    const error: unknown = await checkLimit(raw, FIVE_PER_15).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(String((error as Error).message)).not.toContain("victim");
  });
});

// emailKey refuses oversized input before hashing (QA finding L2), without
// echoing the input in the error.
describe("email length cap", () => {
  it("accepts a 254-character address and rejects a longer one", () => {
    const local = "a".repeat(64);
    const ok = `${local}@${"b".repeat(254 - 65 - 4)}.com`;
    expect(ok).toHaveLength(254);
    expect(() => emailKey("email-reset", ok)).not.toThrow();
    const tooLong = `x${ok}`;
    expect(() => emailKey("email-reset", tooLong)).toThrow(TypeError);
    try {
      emailKey("email-reset", tooLong);
    } catch (error) {
      expect(String(error)).not.toContain(local);
    }
  });
});
