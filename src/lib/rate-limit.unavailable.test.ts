// Tests for src/lib/rate-limit.ts and src/lib/sign-in-limit.ts when MongoDB
// cannot be reached at all: connectDb() is replaced by one that fails, so
// every limiter call must refuse with RateLimitUnavailableError (fail closed).

import { describe, expect, it, vi } from "vitest";

import { DbConnectionError } from "./db";
import {
  RateLimitUnavailableError,
  buildKey,
  checkLimit,
  clearAllForEmail,
  clearAttempts,
  consume,
  consumeSlowdown,
  emailKey,
  hashEmail,
} from "./rate-limit";
import {
  SIGN_IN_SLOWDOWN,
  authLimiterStorage,
  clearSignIn,
  consumeResetRequest,
  consumeSignIn,
} from "./sign-in-limit";

const ONE_PER_MINUTE = { limit: 1, windowSeconds: 60 } as const;

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
    vi.stubEnv("IP_HASH_SECRET", "test-ip-secret-for-rate-limit-tests-012345");
    const email = "jane@example.com";
    const key = emailKey("email-reset", email);
    const request = {
      email,
      headers: new Headers({ "x-vercel-forwarded-for": "203.0.113.7" }),
    };

    for (const call of [
      () => consume(key, ONE_PER_MINUTE),
      () => checkLimit(key, ONE_PER_MINUTE),
      () => clearAttempts(key),
      () =>
        consumeSlowdown(
          buildKey("email-login", hashEmail(email)),
          SIGN_IN_SLOWDOWN,
        ),
      () => clearAllForEmail(email),
      () => consumeSignIn(request),
      () => clearSignIn(request, "network"),
      () => consumeResetRequest(request),
      () =>
        authLimiterStorage.consume("203.0.113.7|/sign-in/email", {
          window: 60,
          max: 10,
        }),
    ]) {
      const error: unknown = await call().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RateLimitUnavailableError);
      expect((error as Error).message).toContain(DbConnectionError.name);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
