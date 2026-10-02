// QA tests for src/lib/rate-limit.ts that try to break the limiter: heavy
// concurrency on new and expired keys, normalisation parity with Better Auth
// (which lowercases only, and rejects non-ASCII emails), and key leakage.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  LOGIN_EMAIL,
  RESET_EMAIL,
  type RateLimitKey,
  checkLimit,
  consume,
  emailKey,
} from "./rate-limit";

const TEST_SECRET = "qa-only-secret-for-rate-limit-tests-abcdef";

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
      emailKey("email-login", `user${i}@example.com`),
    );
    const results = await Promise.all(
      keys.flatMap((key) =>
        Array.from({ length: 40 }, () =>
          consume(key, LOGIN_EMAIL).then((r) => ({ key, r })),
        ),
      ),
    );

    for (const key of keys) {
      const mine = results.filter((x) => x.key === key);
      expect(mine.filter((x) => x.r.allowed)).toHaveLength(LOGIN_EMAIL.limit);
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
    expect(counts.every((d) => d.count === 40)).toBe(true);
  });

  it("resets an expired-but-not-deleted window exactly once under parallel load", async () => {
    const key = emailKey("email-reset", "victim@example.com");
    for (let i = 0; i < 4; i++) await consume(key, RESET_EMAIL);
    const old = new Date(Date.now() - 5_000);
    await LoginAttemptModel.updateOne({ key }, { expiresAt: old });

    const results = await Promise.all(
      Array.from({ length: 30 }, () => consume(key, RESET_EMAIL)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(RESET_EMAIL.limit);
    const doc = await LoginAttemptModel.findOne({ key }).lean();
    // One new window holding all 30 attempts, not several overlapping resets.
    expect(doc?.count).toBe(30);
    expect(doc?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
  });
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
    const keys = new Set(accepted.map((e) => emailKey("email-login", e)));
    expect(keys.size).toBe(1);
  });

  it("keeps addresses that are different accounts in Better Auth on different keys", () => {
    const a = emailKey("email-login", "jane@example.com");
    expect(emailKey("email-login", "jane+1@example.com")).not.toBe(a);
    expect(emailKey("email-login", "jane@example.co")).not.toBe(a);
    expect(emailKey("email-login", "jane.@example.com")).not.toBe(a);
  });

  it("only merges look-alike forms that Better Auth rejects anyway", () => {
    // Kelvin sign U+212A lowercases to ASCII "k": same counter (conservative),
    // and Better Auth's z.email() rejects it, so it never reaches an account.
    const kelvin = "Kate@example.com";
    expect(emailKey("email-login", kelvin)).toBe(
      emailKey("email-login", "kate@example.com"),
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
    const error: unknown = await checkLimit(raw, LOGIN_EMAIL).catch(
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
    expect(() => emailKey("email-login", ok)).not.toThrow();
    const tooLong = `x${ok}`;
    expect(() => emailKey("email-login", tooLong)).toThrow(TypeError);
    try {
      emailKey("email-login", tooLong);
    } catch (error) {
      expect(String(error)).not.toContain(local);
    }
  });
});
