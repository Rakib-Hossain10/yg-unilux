// Tests for src/lib/cloudinary.ts: the upload signature (checked against a
// value computed by hand from Cloudinary's signing rules), the post-upload
// size/format check and the best-effort delete. The SDK's network calls are mocked.

import { createHash } from "node:crypto";

import { v2 as cloudinary } from "cloudinary";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_BYTES } from "./constants";
import { destroyImage, inspectImage, signImageUpload } from "./cloudinary";

const SECRET = "Abc_secret-123";
const PUBLIC_ID =
  "yg/products/0123456789abcdef01234567/3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b";
const TIMESTAMP = 1_700_000_000;

beforeEach(() => {
  vi.stubEnv(
    "CLOUDINARY_URL",
    `cloudinary://123456789012345:${SECRET}@demo-cloud`,
  );
});

describe("signImageUpload", () => {
  it("signs exactly the posted fields with SHA-1 over the sorted params + secret", () => {
    const signed = signImageUpload(PUBLIC_ID, TIMESTAMP);

    // Cloudinary's rule: sort the signed params by name, join as
    // name=value with "&", append the API secret, SHA-1, hex.
    const toSign =
      "allowed_formats=jpg,png,webp,avif&overwrite=false" +
      `&public_id=${PUBLIC_ID}&timestamp=${TIMESTAMP}`;
    const expected = createHash("sha1")
      .update(toSign + SECRET)
      .digest("hex");
    expect(expected).toBe("360480909b60f207ee75a6bfca0861fd50c6f83a");
    expect(signed.fields.signature).toBe(expected);

    expect(signed).toEqual({
      uploadUrl: "https://api.cloudinary.com/v1_1/demo-cloud/image/upload",
      cloudName: "demo-cloud",
      publicId: PUBLIC_ID,
      fields: {
        api_key: "123456789012345",
        timestamp: String(TIMESTAMP),
        public_id: PUBLIC_ID,
        allowed_formats: "jpg,png,webp,avif",
        overwrite: "false",
        signature: expected,
      },
    });
  });

  it("never returns the API secret", () => {
    const signed = signImageUpload(PUBLIC_ID, TIMESTAMP);
    expect(JSON.stringify(signed)).not.toContain(SECRET);
  });

  it("refuses an id or timestamp the server did not build", () => {
    expect(() => signImageUpload("evil/id", TIMESTAMP)).toThrow(TypeError);
    expect(() => signImageUpload(PUBLIC_ID, 1.5)).toThrow(TypeError);
    expect(() => signImageUpload(PUBLIC_ID, 0)).toThrow(TypeError);
  });

  it("fails with an env error, not a bad signature, when CLOUDINARY_URL is unset", () => {
    vi.stubEnv("CLOUDINARY_URL", "");
    expect(() => signImageUpload(PUBLIC_ID, TIMESTAMP)).toThrow(
      /CLOUDINARY_URL/,
    );
  });
});

describe("inspectImage", () => {
  function resourceReturns(value: unknown) {
    return vi.spyOn(cloudinary.api, "resource").mockResolvedValue(value);
  }

  it("accepts an image within the size and format limits", async () => {
    const spy = resourceReturns({
      resource_type: "image",
      format: "webp",
      bytes: 1234,
      width: 800,
      height: 600,
    });
    await expect(inspectImage(PUBLIC_ID)).resolves.toEqual({
      ok: true,
      bytes: 1234,
      format: "webp",
      width: 800,
      height: 600,
    });
    expect(spy).toHaveBeenCalledWith(PUBLIC_ID, {
      resource_type: "image",
      type: "upload",
    });
  });

  it("accepts exactly the size limit and refuses one byte more", async () => {
    resourceReturns({
      resource_type: "image",
      format: "jpg",
      bytes: MAX_IMAGE_BYTES,
    });
    expect((await inspectImage(PUBLIC_ID)).ok).toBe(true);
    resourceReturns({
      resource_type: "image",
      format: "jpg",
      bytes: MAX_IMAGE_BYTES + 1,
    });
    await expect(inspectImage(PUBLIC_ID)).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it.each([
    ["gif", { resource_type: "image", format: "gif", bytes: 10 }],
    ["svg", { resource_type: "image", format: "svg", bytes: 10 }],
    ["pdf", { resource_type: "image", format: "pdf", bytes: 10 }],
    ["no format", { resource_type: "image", bytes: 10 }],
    ["no size", { resource_type: "image", format: "png" }],
    ["a video", { resource_type: "video", format: "mp4", bytes: 10 }],
  ])("refuses %s as bad_format", async (_label, resource) => {
    resourceReturns(resource);
    await expect(inspectImage(PUBLIC_ID)).resolves.toEqual({
      ok: false,
      reason: "bad_format",
    });
  });

  it("reports a 404 as missing", async () => {
    vi.spyOn(cloudinary.api, "resource").mockRejectedValue({
      error: { message: "Resource not found", http_code: 404 },
    });
    await expect(inspectImage(PUBLIC_ID)).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reports other failures as unavailable, logging no details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(cloudinary.api, "resource").mockRejectedValue({
      error: { message: `secret ${SECRET}`, http_code: 420 },
    });
    await expect(inspectImage(PUBLIC_ID)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });
});

describe("destroyImage", () => {
  it("deletes the upload and invalidates CDN copies", async () => {
    const spy = vi
      .spyOn(cloudinary.uploader, "destroy")
      .mockResolvedValue({ result: "ok" });
    await expect(destroyImage(PUBLIC_ID)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledWith(PUBLIC_ID, {
      resource_type: "image",
      type: "upload",
      invalidate: true,
    });
  });

  it("never deletes an id outside our shape", async () => {
    const spy = vi.spyOn(cloudinary.uploader, "destroy");
    await expect(destroyImage("someone/else")).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("swallows and logs a failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(cloudinary.uploader, "destroy").mockRejectedValue({
      error: { message: "boom", http_code: 500 },
    });
    await expect(destroyImage(PUBLIC_ID)).resolves.toBe(false);
    expect(log).toHaveBeenCalledOnce();
  });
});
