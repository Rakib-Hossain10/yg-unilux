import { describe, expect, it } from "vitest";

import { parseCloudinaryUrl } from "./cloudinary-url";

// Fake credentials in the real format. Not a real account.
const KEY = "123456789012345";
const SECRET = "test_secret_0000";
const CLOUD = "demo-cloud_1";
const VALID = `cloudinary://${KEY}:${SECRET}@${CLOUD}`;

describe("parseCloudinaryUrl", () => {
  it("parses the console format into credentials", () => {
    expect(parseCloudinaryUrl(VALID)).toEqual({
      cloudName: CLOUD,
      apiKey: KEY,
      apiSecret: SECRET,
    });
  });

  it("accepts a trailing slash", () => {
    expect(parseCloudinaryUrl(`${VALID}/`)?.cloudName).toBe(CLOUD);
  });

  it.each([
    ["empty string", ""],
    ["not a URL", "just-text"],
    ["the whole KEY=value line pasted as the value", `CLOUDINARY_URL=${VALID}`],
    ["wrong scheme", `https://${KEY}:${SECRET}@${CLOUD}`],
    ["missing secret", `cloudinary://${KEY}@${CLOUD}`],
    ["empty secret", `cloudinary://${KEY}:@${CLOUD}`],
    ["missing key and secret", `cloudinary://${CLOUD}`],
    ["missing cloud name", `cloudinary://${KEY}:${SECRET}@`],
    ["non-numeric API key", `cloudinary://abc:${SECRET}@${CLOUD}`],
    [
      "secret with illegal characters",
      `cloudinary://${KEY}:se%20cret@${CLOUD}`,
    ],
    ["cloud name with a dot", `cloudinary://${KEY}:${SECRET}@demo.cloud`],
    ["a port", `cloudinary://${KEY}:${SECRET}@${CLOUD}:8080`],
    ["a path", `cloudinary://${KEY}:${SECRET}@${CLOUD}/extra`],
    ["query parameters", `${VALID}?secure_distribution=cdn.example.com`],
    ["a fragment", `${VALID}#x`],
    ["malformed percent-encoding", `cloudinary://${KEY}:%E0%A4%A@${CLOUD}`],
  ])("rejects %s", (_label, value) => {
    expect(parseCloudinaryUrl(value)).toBeNull();
  });

  it("never throws, whatever the input", () => {
    for (const value of ["%", "cloudinary://", "cloudinary://:@", "\u0000"]) {
      expect(() => parseCloudinaryUrl(value)).not.toThrow();
    }
  });
});
