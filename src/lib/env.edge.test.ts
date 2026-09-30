import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { EnvError, env } from "./env";

// Edge cases for src/lib/env.ts added by the Phase 0 QA review.

const ALL_KEYS = [
  "MONGODB_URI",
  "AUTH_SECRET",
  "AUTH_URL",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "COMPANY_EMAIL",
  "GEO_BLOCK_ENABLED",
  "WHISTLEBLOWER_ENC_KEY",
  "CRON_SECRET",
  "SITE_URL",
] as const;

function envErrorOf(fn: () => unknown): EnvError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return error as EnvError;
  }
  throw new Error("expected an EnvError to be thrown");
}

beforeEach(() => {
  for (const key of ALL_KEYS) vi.stubEnv(key, undefined);
});

describe("types", () => {
  it("marks optional variables as possibly undefined", () => {
    expectTypeOf(env.auth).returns.toEqualTypeOf<{
      secret: string;
      url: string | undefined;
    }>();
    expectTypeOf(env.whistleblowerKey).returns.toEqualTypeOf<Buffer>();
    expectTypeOf(env.geoBlockEnabled).returns.toEqualTypeOf<boolean>();
  });
});

describe("whitespace", () => {
  it.each([
    ["CLOUDINARY_API_SECRET", () => env.cloudinary()],
    ["R2_SECRET_ACCESS_KEY", () => env.r2()],
    ["RESEND_API_KEY", () => env.email()],
    ["AUTH_SECRET", () => env.auth()],
    ["CRON_SECRET", () => env.cronSecret()],
  ])("rejects a whitespace-only %s", (key, read) => {
    vi.stubEnv(key, " ".repeat(40));
    expect(envErrorOf(read).variables).toContain(key);
  });

  it("rejects a MONGODB_URI with a trailing newline instead of passing it on", () => {
    vi.stubEnv("MONGODB_URI", "mongodb+srv://u:p@c.example.net/yg\n");
    expect(envErrorOf(() => env.mongo()).variables).toEqual(["MONGODB_URI"]);
  });

  it("rejects a WHISTLEBLOWER_ENC_KEY with a trailing newline", () => {
    vi.stubEnv(
      "WHISTLEBLOWER_ENC_KEY",
      `${randomBytes(32).toString("base64")}\n`,
    );
    expect(envErrorOf(() => env.whistleblowerKey()).variables).toEqual([
      "WHISTLEBLOWER_ENC_KEY",
    ]);
  });

  it("treats a whitespace-only GEO_BLOCK_ENABLED as invalid, not as on", () => {
    vi.stubEnv("GEO_BLOCK_ENABLED", "   ");
    expect(envErrorOf(() => env.geoBlockEnabled()).variables).toEqual([
      "GEO_BLOCK_ENABLED",
    ]);
  });
});

describe("WHISTLEBLOWER_ENC_KEY length and encoding", () => {
  it.each([
    ["31 bytes", randomBytes(31).toString("base64")],
    ["33 bytes", randomBytes(33).toString("base64")],
    ["64 bytes", randomBytes(64).toString("base64")],
    ["hex of 32 bytes", randomBytes(32).toString("hex")],
    [
      "base64url of 32 bytes",
      // Force a '-' or '_' so this is never also canonical base64.
      `-_${randomBytes(32).toString("base64url").slice(2)}`,
    ],
    ["unpadded base64", randomBytes(32).toString("base64").replace(/=+$/, "")],
  ])("rejects %s", (_label, value) => {
    vi.stubEnv("WHISTLEBLOWER_ENC_KEY", value);
    expect(envErrorOf(() => env.whistleblowerKey()).variables).toEqual([
      "WHISTLEBLOWER_ENC_KEY",
    ]);
  });
});

describe("URL validation", () => {
  it.each([
    "https://www.example.com",
    "http://localhost:3000",
    "https://example.com/base/",
  ])("accepts SITE_URL %j", (value) => {
    vi.stubEnv("SITE_URL", value);
    expect(env.siteUrl().href.startsWith(value.toLowerCase())).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "//example.com",
    "example.com",
    "https://",
  ])("rejects SITE_URL %j", (value) => {
    vi.stubEnv("SITE_URL", value);
    expect(envErrorOf(() => env.siteUrl()).variables).toEqual(["SITE_URL"]);
  });
});

describe("email validation", () => {
  it.each([
    "a@b",
    "no-reply@",
    "@example.com",
    "a b@example.com",
    " x@example.com",
  ])("rejects COMPANY_EMAIL %j", (value) => {
    vi.stubEnv("COMPANY_EMAIL", value);
    expect(envErrorOf(() => env.companyEmail()).variables).toEqual([
      "COMPANY_EMAIL",
    ]);
  });

  it.each([
    "YG UniLUX <not-an-email>",
    "YG UniLUX <a@b.com> trailing",
    "YG <a@b.com><c@d.com>",
    "<>",
  ])("rejects EMAIL_FROM %j", (value) => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", value);
    expect(envErrorOf(() => env.email()).variables).toEqual(["EMAIL_FROM"]);
  });
});

describe("secrecy of every group", () => {
  const SECRET = "Zq9Leak7Canary3Value";
  it.each([
    ["CLOUDINARY_API_SECRET", () => env.cloudinary()],
    ["R2_SECRET_ACCESS_KEY", () => env.r2()],
    ["EMAIL_FROM", () => env.email()],
    ["COMPANY_EMAIL", () => env.companyEmail()],
    ["AUTH_URL", () => env.auth()],
  ])("never echoes %s or its neighbours in the error", (key, read) => {
    // Set every variable of the group to a canary so the error is caused by
    // the invalid or missing ones, and the valid-looking ones must not leak.
    for (const k of ALL_KEYS) vi.stubEnv(k, `${SECRET}-${k}`);
    vi.stubEnv(key, `${SECRET}-${key}`);
    let error: EnvError | undefined;
    try {
      read();
    } catch (e) {
      error = e as EnvError;
    }
    if (!error) return; // Group accepted the canaries: nothing to leak.
    const serialised = [
      error.message,
      String(error.stack),
      JSON.stringify(error),
      JSON.stringify(Object.getOwnPropertyDescriptors(error)),
    ].join("\n");
    expect(serialised).not.toContain(SECRET);
  });
});
