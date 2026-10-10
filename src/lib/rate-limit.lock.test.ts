// Tests for the short in-flight lock in src/lib/rate-limit.ts (acquireLock /
// releaseLock, ADR 0070: one invite at a time per customer), on a real
// in-memory MongoDB so the unique-index race and the DB clock are real.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  acquireLock,
  buildKey,
  hashUserId,
  RateLimitUnavailableError,
  releaseLock,
} from "./rate-limit";

// A test-only secret (not a real one): 32+ characters, as env.auth() requires.
const TEST_SECRET = "test-secret-for-lock-tests-0123456789abcdef";

setupMemoryDb("yg_rate_limit_lock_test");

beforeAll(async () => {
  await LoginAttemptModel.createIndexes();
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", TEST_SECRET);
  await LoginAttemptModel.deleteMany({});
});

let counter = 0;
const lockKey = () => buildKey("invite-lock", hashUserId(`user-${++counter}`));

describe("acquireLock / releaseLock", () => {
  it("a free key is taken; a held key is refused", async () => {
    const key = lockKey();
    const owner = await acquireLock(key, 30);
    expect(owner).toEqual(expect.any(String));
    expect(await acquireLock(key, 30)).toBeNull();
  });

  it("after release the key can be taken again", async () => {
    const key = lockKey();
    const owner = await acquireLock(key, 30);
    await releaseLock(key, owner ?? "");
    expect(await acquireLock(key, 30)).not.toBeNull();
  });

  it("an ended lock is taken over", async () => {
    const key = lockKey();
    await LoginAttemptModel.create({
      key,
      count: 1,
      owner: "crashed-holder",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await acquireLock(key, 30)).not.toBeNull();
  });

  it("of 20 parallel callers exactly one gets the lock", async () => {
    const key = lockKey();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireLock(key, 30)),
    );
    expect(results.filter((owner) => owner !== null)).toHaveLength(1);
  });

  it("a caller whose lock ran out never frees the new holder's lock", async () => {
    const key = lockKey();
    const first = await acquireLock(key, 30);
    // The first lock runs out; a second caller takes over.
    await LoginAttemptModel.updateOne(
      { key },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const second = await acquireLock(key, 30);
    expect(second).not.toBeNull();
    await releaseLock(key, first ?? "");
    // Still held by the second caller.
    expect(await acquireLock(key, 30)).toBeNull();
  });

  it("refuses a bad duration and a malformed key before any query", async () => {
    await expect(acquireLock(lockKey(), 0)).rejects.toThrow(TypeError);
    await expect(acquireLock(lockKey(), 1.5)).rejects.toThrow(TypeError);
    await expect(
      acquireLock("invite-lock:raw" as ReturnType<typeof lockKey>, 30),
    ).rejects.toThrow(TypeError);
  });

  it("a database failure is RateLimitUnavailableError", async () => {
    vi.spyOn(LoginAttemptModel, "findOneAndUpdate").mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(acquireLock(lockKey(), 30)).rejects.toBeInstanceOf(
      RateLimitUnavailableError,
    );
  });
});
