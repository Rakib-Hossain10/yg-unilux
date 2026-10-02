// Tests for src/lib/rate-limit.ts when MongoDB cannot be reached at all:
// connectDb() is replaced by one that fails, so every limiter call must
// refuse with RateLimitUnavailableError instead of allowing or locking out.

import { describe, expect, it, vi } from "vitest";

import { DbConnectionError } from "./db";
import {
  LOGIN_EMAIL,
  RateLimitUnavailableError,
  checkLimit,
  clearAttempts,
  consume,
  emailKey,
} from "./rate-limit";

vi.mock("./db", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db")>();
  return {
    ...original,
    connectDb: vi.fn(() =>
      Promise.reject(
        new original.DbConnectionError(
          "could not connect",
          new Error("timeout"),
        ),
      ),
    ),
  };
});

describe("when the database is unreachable", () => {
  it("every operation throws RateLimitUnavailableError", async () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-for-rate-limit-tests-0123456789");
    const key = emailKey("email-login", "jane@example.com");

    for (const call of [
      () => consume(key, LOGIN_EMAIL),
      () => checkLimit(key, LOGIN_EMAIL),
      () => clearAttempts(key),
    ]) {
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitUnavailableError);
      expect((error as Error).message).toContain(DbConnectionError.name);
    }
  });
});
