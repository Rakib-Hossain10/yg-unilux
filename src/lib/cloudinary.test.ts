// Tests for src/lib/cloudinary.ts: the upload signature (checked against a
// value computed by hand from Cloudinary's signing rules), the post-upload
// size/format check, the best-effort delete and the server-side upload used by
// the bulk import. The SDK's network calls are mocked.

import { createHash } from "node:crypto";

import { v2 as cloudinary } from "cloudinary";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_BYTES } from "./constants";
import {
  destroyImage,
  inspectImage,
  signImageUpload,
  uploadImageBuffer,
} from "./cloudinary";
import { isOwnPublicId } from "./cloudinary-ids";

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

  it("signs a custom format list (category icons allow svg)", () => {
    const signed = signImageUpload(PUBLIC_ID, TIMESTAMP, [
      "png",
      "svg",
      "webp",
    ]);
    const toSign =
      "allowed_formats=png,svg,webp&overwrite=false" +
      `&public_id=${PUBLIC_ID}&timestamp=${TIMESTAMP}`;
    expect(signed.fields.allowed_formats).toBe("png,svg,webp");
    expect(signed.fields.signature).toBe(
      createHash("sha1")
        .update(toSign + SECRET)
        .digest("hex"),
    );
  });

  it("refuses an empty or odd format list", () => {
    expect(() => signImageUpload(PUBLIC_ID, TIMESTAMP, [])).toThrow(TypeError);
    expect(() =>
      signImageUpload(PUBLIC_ID, TIMESTAMP, ["png&overwrite=true"]),
    ).toThrow(TypeError);
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

  it("checks against a custom format list when given one", async () => {
    resourceReturns({ resource_type: "image", format: "svg", bytes: 10 });
    expect((await inspectImage(PUBLIC_ID, ["png", "svg", "webp"])).ok).toBe(
      true,
    );
    await expect(inspectImage(PUBLIC_ID, ["PNG"])).rejects.toThrow(TypeError);
    resourceReturns({ resource_type: "image", format: "jpg", bytes: 10 });
    await expect(
      inspectImage(PUBLIC_ID, ["png", "svg", "webp"]),
    ).resolves.toEqual({ ok: false, reason: "bad_format" });
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

describe("uploadImageBuffer", () => {
  const OWNER = "0123456789abcdef01234567";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  // sha256 of these 7 bytes, computed independently with `sha256sum`.
  const PNG_SHA256 =
    "cdf3cefe7ec6253d1cb4828ab654da6beb8a4727daac0c49dbf26bedf5887f79";
  /* What the Upload API reports for a normal PNG upload. */
  const STORED_PNG = {
    resource_type: "image",
    format: "png",
    bytes: 7,
    width: 2,
    height: 1,
  };

  type UploadCallback = (error: unknown, result?: unknown) => void;
  type Answer = { error?: unknown; result?: unknown };

  /** Mocks upload_stream; `respond` builds the answer from the options sent. */
  function mockUpload(respond: (options: Record<string, unknown>) => Answer) {
    const written: Uint8Array[] = [];
    const spy = vi
      .spyOn(cloudinary.uploader, "upload_stream")
      .mockImplementation(((
        options: Record<string, unknown>,
        callback: UploadCallback,
      ) => ({
        end(chunk: Uint8Array) {
          written.push(chunk);
          const { error, result } = respond(options);
          callback(error, result);
        },
      })) as never);
    return { spy, written };
  }

  /* Answers with the id it was asked to use and these stored facts. */
  const stored =
    (facts: Record<string, unknown> = STORED_PNG) =>
    (options: Record<string, unknown>): Answer => ({
      result: { public_id: options.public_id, ...facts },
    });

  function sentOptions(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls[0]?.[0] as Record<string, unknown>;
  }

  /* Mocked (never pass-through) so a regression can't reach the network. */
  function mockDestroy() {
    return vi
      .spyOn(cloudinary.uploader, "destroy")
      .mockResolvedValue({ result: "ok" });
  }
  function mockResource() {
    return vi.spyOn(cloudinary.api, "resource").mockResolvedValue({});
  }

  it("uploads signed to a new server id in the product folder with overwrite:false and keeps a valid image", async () => {
    const { spy, written } = mockUpload(stored());
    const resource = mockResource();
    const destroy = mockDestroy();

    const out = await uploadImageBuffer(OWNER, PNG);

    const options = sentOptions(spy);
    const publicId = options.public_id as string;
    expect(isOwnPublicId("product", OWNER, publicId)).toBe(true);
    expect(options).toEqual({
      public_id: publicId,
      resource_type: "image",
      type: "upload",
      overwrite: false,
      allowed_formats: ["jpg", "png", "webp", "avif"],
    });
    expect(Buffer.concat(written)).toEqual(Buffer.from(PNG));
    // The checks run on the Upload API answer: no Admin API call per image.
    expect(resource).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(out).toEqual({
      ok: true,
      image: {
        publicId,
        sourceSha256: PNG_SHA256,
        bytes: 7,
        format: "png",
        width: 2,
        height: 1,
      },
    });
  });

  it("uploads and hashes exactly the bytes of a view into a larger buffer", async () => {
    const { written } = mockUpload(stored());
    const backing = new Uint8Array(20).fill(9);
    backing.set(PNG, 5);
    const out = await uploadImageBuffer(OWNER, backing.subarray(5, 12));
    expect(Buffer.concat(written)).toEqual(Buffer.from(PNG));
    expect(out.ok && out.image.sourceSha256).toBe(PNG_SHA256);
  });

  it("uses a different id on every call", async () => {
    const { spy } = mockUpload(stored());
    await uploadImageBuffer(OWNER, PNG);
    await uploadImageBuffer(OWNER, PNG);
    const ids = spy.mock.calls.map(
      (call) => (call[0] as unknown as { public_id: string }).public_id,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["a gif", { ...STORED_PNG, format: "gif" }, "bad_format"],
    ["a video", { ...STORED_PNG, resource_type: "video" }, "bad_format"],
    ["no size", { ...STORED_PNG, bytes: undefined }, "bad_format"],
    [
      "over the size limit",
      { ...STORED_PNG, bytes: MAX_IMAGE_BYTES + 1 },
      "too_large",
    ],
  ])(
    "destroys the new asset when Cloudinary stored %s",
    async (_n, facts, reason) => {
      const { spy } = mockUpload(stored(facts));
      const destroy = mockDestroy();
      await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
        ok: false,
        reason,
      });
      expect(destroy).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledWith(sentOptions(spy).public_id, {
        resource_type: "image",
        type: "upload",
        invalidate: true,
      });
    },
  );

  it("still reports the rejection when the clean-up delete fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpload(stored({ ...STORED_PNG, format: "gif" }));
    vi.spyOn(cloudinary.uploader, "destroy").mockRejectedValue({
      error: { http_code: 500 },
    });
    await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
      ok: false,
      reason: "bad_format",
    });
  });

  it("maps a refused upload (400) to bad_format and other failures to unavailable, logging no details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const destroy = mockDestroy();
    mockUpload(() => ({
      error: { message: `Invalid image file ${SECRET}`, http_code: 400 },
    }));
    await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
      ok: false,
      reason: "bad_format",
    });
    mockUpload(() => ({ error: { message: "rate", http_code: 420 } }));
    await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    mockUpload(() => ({ error: undefined, result: undefined }));
    await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(destroy).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });

  it("never keeps or destroys an asset that already existed under the id", async () => {
    mockUpload(stored({ ...STORED_PNG, existing: true }));
    const destroy = mockDestroy();
    await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
      ok: false,
      reason: "exists",
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("refuses an answer for another id, destroying it only when it is in this product's folder", async () => {
    const other = `yg/products/${OWNER}/3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b`;
    mockUpload(() => ({ result: { ...STORED_PNG, public_id: other } }));
    const destroy = mockDestroy();
    await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(destroy).toHaveBeenCalledWith(other, expect.anything());

    destroy.mockClear();
    mockUpload(() => ({
      result: { ...STORED_PNG, public_id: "someone/else/photo" },
    }));
    await expect(uploadImageBuffer(OWNER, PNG)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("uploads nothing for an empty or oversize buffer", async () => {
    const { spy } = mockUpload(stored());
    await expect(uploadImageBuffer(OWNER, new Uint8Array(0))).resolves.toEqual({
      ok: false,
      reason: "bad_format",
    });
    await expect(
      uploadImageBuffer(OWNER, new Uint8Array(MAX_IMAGE_BYTES + 1)),
    ).resolves.toEqual({ ok: false, reason: "too_large" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a product id that is not a lowercase ObjectId", async () => {
    const { spy } = mockUpload(stored());
    for (const id of ["../x", OWNER.toUpperCase(), "aaaaaaaaaaaa"]) {
      await expect(uploadImageBuffer(id, PNG)).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
