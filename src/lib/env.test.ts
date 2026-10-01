import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnvError, env } from "./env";

const ALL_KEYS = [
  "MONGODB_URI",
  "AUTH_SECRET",
  "AUTH_URL",
  "CLOUDINARY_URL",
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

/** Runs `fn`, expects it to throw an EnvError and returns that error. */
function captureEnvError(fn: () => unknown): EnvError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return error as EnvError;
  }
  throw new Error("expected an EnvError to be thrown");
}

beforeEach(() => {
  // Start every test from "no secrets set", like CI and a fresh checkout.
  for (const key of ALL_KEYS) vi.stubEnv(key, undefined);
});

describe("lazy validation", () => {
  it("can be imported and used for unrelated features with no secrets set", () => {
    expect(env.geoBlockEnabled()).toBe(false);
  });

  it("names the missing variable when a feature is used", () => {
    const error = captureEnvError(() => env.mongo());
    expect(error.message).toContain("MONGODB_URI");
    expect(error.message).toMatch(/missing/i);
    expect(error.variables).toEqual(["MONGODB_URI"]);
  });

  it("treats an empty string as missing (values in .env.example are empty)", () => {
    vi.stubEnv("MONGODB_URI", "");
    expect(captureEnvError(() => env.mongo()).variables).toEqual([
      "MONGODB_URI",
    ]);
  });

  it("lists every missing variable of a group at once", () => {
    vi.stubEnv("R2_BUCKET", "datasheets");
    const error = captureEnvError(() => env.r2());
    expect(error.variables).toEqual([
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ]);
  });
});

describe("valid values", () => {
  it("returns the mongo config", () => {
    vi.stubEnv(
      "MONGODB_URI",
      "mongodb+srv://user:pw@cluster0.example.mongodb.net/yg",
    );
    expect(env.mongo()).toEqual({
      uri: "mongodb+srv://user:pw@cluster0.example.mongodb.net/yg",
    });
  });

  it.each([
    "mongodb+srv://user:pw@cluster0.example.mongodb.net/yg_unilux?retryWrites=true&w=majority",
    "mongodb://h1.example.net:27017,h2.example.net:27017/yg?replicaSet=rs0",
    "mongodb://127.0.0.1:27017/yg_dev",
  ])("accepts a MONGODB_URI that names its database: %s", (uri) => {
    vi.stubEnv("MONGODB_URI", uri);
    expect(env.mongo()).toEqual({ uri });
  });

  it("returns the r2 config", () => {
    vi.stubEnv("R2_ACCOUNT_ID", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("R2_ACCESS_KEY_ID", "access-key-id");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret-access-key");
    vi.stubEnv("R2_BUCKET", "yg-private");
    expect(env.r2()).toEqual({
      accountId: "0123456789abcdef0123456789abcdef",
      accessKeyId: "access-key-id",
      secretAccessKey: "secret-access-key",
      bucket: "yg-private",
    });
  });

  it("accepts EMAIL_FROM as a bare address or as 'Name <address>'", () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "YG UniLUX <no-reply@example.com>");
    expect(env.email().from).toBe("YG UniLUX <no-reply@example.com>");
    vi.stubEnv("EMAIL_FROM", "no-reply@example.com");
    expect(env.email().from).toBe("no-reply@example.com");
  });

  it("decodes WHISTLEBLOWER_ENC_KEY to 32 raw bytes", () => {
    const key = randomBytes(32);
    vi.stubEnv("WHISTLEBLOWER_ENC_KEY", key.toString("base64"));
    const decoded = env.whistleblowerKey();
    expect(decoded).toBeInstanceOf(Buffer);
    expect(decoded.equals(key)).toBe(true);
  });

  it("allows AUTH_URL to be unset (Auth.js infers it on Vercel)", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    expect(env.auth()).toEqual({ secret: "a".repeat(32), url: undefined });
  });
});

describe("bad formats", () => {
  it.each([
    ["MONGODB_URI", "postgres://localhost/db", () => env.mongo()],
    // No database name: the driver would silently use "test" (see db.ts).
    [
      "MONGODB_URI",
      "mongodb+srv://u:p@cluster0.example.mongodb.net/?retryWrites=true",
      () => env.mongo(),
    ],
    [
      "MONGODB_URI",
      "mongodb+srv://u:p@cluster0.example.mongodb.net",
      () => env.mongo(),
    ],
    ["MONGODB_URI", "mongodb://127.0.0.1:27017/", () => env.mongo()],
    ["AUTH_SECRET", "too-short", () => env.auth()],
    ["SITE_URL", "not a url", () => env.siteUrl()],
    ["SITE_URL", "ftp://example.com", () => env.siteUrl()],
    ["COMPANY_EMAIL", "not-an-email", () => env.companyEmail()],
    ["CRON_SECRET", "short", () => env.cronSecret()],
    ["WHISTLEBLOWER_ENC_KEY", "not base64 !!", () => env.whistleblowerKey()],
    [
      "WHISTLEBLOWER_ENC_KEY",
      randomBytes(16).toString("base64"),
      () => env.whistleblowerKey(),
    ],
  ])("rejects an invalid %s", (key, value, read) => {
    if (key === "AUTH_SECRET") vi.stubEnv("AUTH_URL", "https://example.com");
    vi.stubEnv(key, value);
    const error = captureEnvError(read);
    expect(error.variables).toEqual([key]);
    expect(error.message).toMatch(/invalid/i);
  });

  it("rejects AUTH_URL when set but not a URL", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("AUTH_URL", "localhost:3000");
    expect(captureEnvError(() => env.auth()).variables).toEqual(["AUTH_URL"]);
  });
});

describe("surrounding whitespace", () => {
  it.each([
    ["AUTH_SECRET", ` ${"a".repeat(32)}`, () => env.auth()],
    ["CRON_SECRET", `${"c".repeat(32)}\n`, () => env.cronSecret()],
    ["RESEND_API_KEY", "re_live_key ", () => env.email()],
    ["R2_SECRET_ACCESS_KEY", "\tsecret", () => env.r2()],
    ["SITE_URL", "https://example.com ", () => env.siteUrl()],
    ["COMPANY_EMAIL", "info@example.com\r\n", () => env.companyEmail()],
  ])("rejects %s with leading or trailing whitespace", (key, value, read) => {
    vi.stubEnv(key, value);
    const error = captureEnvError(read);
    expect(error.variables).toContain(key);
    expect(error.message).toMatch(new RegExp(`${key}: invalid.*whitespace`));
  });

  it("reports a whitespace-only required value as blank", () => {
    vi.stubEnv("MONGODB_URI", "   ");
    const error = captureEnvError(() => env.mongo());
    expect(error.variables).toEqual(["MONGODB_URI"]);
    expect(error.message).toMatch(/MONGODB_URI: missing \(only whitespace\)/);
  });

  it("reports a whitespace-only optional value instead of ignoring it", () => {
    vi.stubEnv("AUTH_SECRET", "a".repeat(32));
    vi.stubEnv("AUTH_URL", "  ");
    expect(captureEnvError(() => env.auth()).variables).toEqual(["AUTH_URL"]);
  });
});

describe("GEO_BLOCK_ENABLED", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["0", false],
    ["FALSE", false],
    ["true", true],
    ["1", true],
    ["TRUE", true],
    [" true ", true],
  ])("parses %j as %s", (value, expected) => {
    vi.stubEnv("GEO_BLOCK_ENABLED", value);
    expect(env.geoBlockEnabled()).toBe(expected);
  });

  it.each(["yes", "on", "enabled", "2"])(
    "rejects the ambiguous value %j",
    (value) => {
      vi.stubEnv("GEO_BLOCK_ENABLED", value);
      expect(captureEnvError(() => env.geoBlockEnabled()).variables).toEqual([
        "GEO_BLOCK_ENABLED",
      ]);
    },
  );
});

describe("CLOUDINARY_URL", () => {
  it("returns the cloud name, API key and API secret", () => {
    vi.stubEnv(
      "CLOUDINARY_URL",
      "cloudinary://123456789012345:test_secret_0000@demo-cloud",
    );
    expect(env.cloudinary()).toEqual({
      cloudName: "demo-cloud",
      apiKey: "123456789012345",
      apiSecret: "test_secret_0000",
    });
  });

  it("names CLOUDINARY_URL when it is missing", () => {
    const error = captureEnvError(() => env.cloudinary());
    expect(error.variables).toEqual(["CLOUDINARY_URL"]);
  });

  it.each([
    ["the whole KEY=value line", "CLOUDINARY_URL=cloudinary://1:abc@demo"],
    ["a bare cloud name", "demo-cloud"],
  ])("rejects %s and shows the expected format", (_label, value) => {
    vi.stubEnv("CLOUDINARY_URL", value);
    const error = captureEnvError(() => env.cloudinary());
    expect(error.message).toContain("CLOUDINARY_URL: invalid");
    expect(error.message).toContain(
      "cloudinary://<api_key>:<api_secret>@<cloud_name>",
    );
  });
});

describe("secrecy", () => {
  it.each([
    [
      "MONGODB_URI",
      "mysql://admin:Sup3rS3cretPassw0rd@db.internal/x",
      () => env.mongo(),
    ],
    ["AUTH_SECRET", "Sup3rS3cret", () => env.auth()],
    ["CRON_SECRET", "Sup3rS3cret", () => env.cronSecret()],
    [
      "WHISTLEBLOWER_ENC_KEY",
      "Sup3rS3cretKeyMaterial==",
      () => env.whistleblowerKey(),
    ],
    ["SITE_URL", "Sup3rS3cret", () => env.siteUrl()],
    ["GEO_BLOCK_ENABLED", "Sup3rS3cret", () => env.geoBlockEnabled()],
    [
      // Well-formed apart from the port, so the secret part is realistic.
      "CLOUDINARY_URL",
      "cloudinary://123456789012345:Sup3rS3cretApiSecret@demo:443",
      () => env.cloudinary(),
    ],
  ])("never puts the value of %s in the error", (key, value, read) => {
    vi.stubEnv(key, value);
    const error = captureEnvError(read);
    const serialised = [
      error.message,
      String(error.stack),
      JSON.stringify(error),
    ].join("\n");
    expect(serialised).not.toContain(value);
    expect(serialised).not.toContain("Sup3rS3cret");
    expect(error.cause).toBeUndefined();
  });
});
