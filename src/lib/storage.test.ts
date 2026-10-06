// Tests for the R2 storage module that need no network: a presigned PUT is
// path-style on the account host, short-lived, and signs type and length.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { presignPut, PRESIGNED_PUT_TTL_SECONDS } from "./storage";

beforeEach(() => {
  vi.stubEnv("R2_ACCOUNT_ID", "acct123");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIATESTKEY");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret-secret-secret");
  vi.stubEnv("R2_BUCKET", "yg-private");
});

describe("presignPut", () => {
  it("is path-style on the account host, with a 5 minute expiry", async () => {
    const put = await presignPut({
      key: "incoming/abc.xlsx",
      contentType: "application/octet-stream",
      contentLength: 1234,
    });
    const url = new URL(put.url);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/yg-private/incoming/abc.xlsx");
    expect(url.searchParams.get("X-Amz-Expires")).toBe(
      String(PRESIGNED_PUT_TTL_SECONDS),
    );
    expect(put.expiresIn).toBe(300);
    expect(put.headers).toEqual({ "Content-Type": "application/octet-stream" });
  });

  it("signs the content type and the content length", async () => {
    const put = await presignPut({
      key: "incoming/abc.xlsx",
      contentType: "application/octet-stream",
      contentLength: 1234,
    });
    const signed = new URL(put.url).searchParams.get("X-Amz-SignedHeaders");
    expect(signed).toContain("content-type");
    expect(signed).toContain("content-length");
  });
});
