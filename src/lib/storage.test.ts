// Tests for the R2 storage module that need no network: a presigned PUT is
// path-style on the account host, short-lived, and signs type and length;
// HEAD returns the ETag, and the conditional read/copy send it and turn a 412
// into StorageConditionError (gate E L-1). Bulk import staging: the presign
// signs size and the .xlsx type on a server-built `imports/` key, and the
// capped read refuses a body over 30 MB without buffering past the cap.

import {
  CopyObjectCommand,
  GetObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_IMPORT_BYTES, XLSX_MIME_TYPE } from "./constants";
import { IMPORT_KEY_PATTERN } from "./schemas/import";
import {
  attachmentDisposition,
  copyObject,
  deleteImportUpload,
  getImportBytes,
  getObjectBytes,
  headObject,
  presignGet,
  presignImportUpload,
  presignPut,
  PRESIGNED_PUT_TTL_SECONDS,
  StorageConditionError,
} from "./storage";

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

function preconditionFailed(): S3ServiceException {
  return new S3ServiceException({
    name: "PreconditionFailed",
    $fault: "client",
    $metadata: { httpStatusCode: 412 },
    message: "At least one of the pre-conditions you specified did not hold",
  });
}

describe("ETag-pinned read and copy", () => {
  it("headObject returns the ETag", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      ContentLength: 12,
      ContentType: "x",
      ETag: '"abc"',
    } as never);
    expect(await headObject("incoming/a.xlsx")).toEqual({
      size: 12,
      contentType: "x",
      etag: '"abc"',
    });
  });

  it("copyObject sends CopySourceIfMatch", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({} as never);
    await copyObject("incoming/a.xlsx", "datasheets/b.xlsx", {
      ifMatch: '"abc"',
    });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(CopyObjectCommand);
    expect((command as CopyObjectCommand).input).toMatchObject({
      Bucket: "yg-private",
      CopySource: "yg-private/incoming/a.xlsx",
      CopySourceIfMatch: '"abc"',
      Key: "datasheets/b.xlsx",
    });
  });

  it("getObjectBytes sends If-Match", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2]) },
    } as never);
    expect(
      await getObjectBytes("incoming/a.xlsx", 10, { ifMatch: '"abc"' }),
    ).toEqual(new Uint8Array([1, 2]));
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toMatchObject({
      Range: "bytes=0-10",
      IfMatch: '"abc"',
    });
  });

  it("a failed condition becomes StorageConditionError (no request detail)", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(
      preconditionFailed() as never,
    );
    const copy = copyObject("incoming/a.xlsx", "datasheets/b.xlsx", {
      ifMatch: '"abc"',
    });
    await expect(copy).rejects.toBeInstanceOf(StorageConditionError);
    await expect(copy).rejects.toThrow(/changed/);
    await expect(
      getObjectBytes("incoming/a.xlsx", 10, { ifMatch: '"abc"' }),
    ).rejects.toBeInstanceOf(StorageConditionError);
  });

  it("other copy errors pass through unchanged", async () => {
    const boom = new Error("network down");
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(boom as never);
    await expect(
      copyObject("incoming/a.xlsx", "datasheets/b.xlsx", { ifMatch: '"x"' }),
    ).rejects.toBe(boom);
  });
});

describe("presignImportUpload", () => {
  it("signs a server-built imports/ key, the .xlsx type and the exact length for 5 minutes", async () => {
    const ticket = await presignImportUpload({
      contentType: XLSX_MIME_TYPE,
      contentLength: 4321,
    });
    expect(ticket.key).toMatch(IMPORT_KEY_PATTERN);
    const url = new URL(ticket.url);
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/yg-private/${ticket.key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signed.split(";")).toEqual(
      expect.arrayContaining(["content-type", "content-length"]),
    );
    expect(ticket.headers).toEqual({ "Content-Type": XLSX_MIME_TYPE });
    expect(ticket.expiresIn).toBe(300);
  });

  it("never reuses a key", async () => {
    const one = await presignImportUpload({
      contentType: XLSX_MIME_TYPE,
      contentLength: 10,
    });
    const two = await presignImportUpload({
      contentType: XLSX_MIME_TYPE,
      contentLength: 10,
    });
    expect(one.key).not.toBe(two.key);
  });

  it("accepts exactly 30 MB", async () => {
    await expect(
      presignImportUpload({
        contentType: XLSX_MIME_TYPE,
        contentLength: MAX_IMPORT_BYTES,
      }),
    ).resolves.toMatchObject({ expiresIn: 300 });
  });

  it.each([
    ["one byte over 30 MB", MAX_IMPORT_BYTES + 1],
    ["zero bytes", 0],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
  ])("refuses %s before signing", async (_name, contentLength) => {
    await expect(
      presignImportUpload({ contentType: XLSX_MIME_TYPE, contentLength }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it.each([
    "application/octet-stream",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "text/csv",
    "",
  ])("refuses the type %j", async (contentType) => {
    await expect(
      presignImportUpload({ contentType, contentLength: 10 }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("getImportBytes", () => {
  const KEY = "imports/11111111-1111-4111-8111-111111111111.xlsx";

  function notFound(): S3ServiceException {
    return new S3ServiceException({
      name: "NoSuchKey",
      $fault: "client",
      $metadata: { httpStatusCode: 404 },
      message: "not found",
    });
  }

  it.each([
    "incoming/11111111-1111-4111-8111-111111111111.xlsx",
    "imports/11111111-1111-4111-8111-111111111111Xxlsx",
    "imports/../datasheets/11111111-1111-4111-8111-111111111111.xlsx",
    "importsX11111111-1111-4111-8111-111111111111.xlsx",
  ])("refuses the key %j without a request", async (key) => {
    const send = vi.spyOn(S3Client.prototype, "send");
    await expect(getImportBytes(key)).rejects.toBeInstanceOf(TypeError);
    await expect(deleteImportUpload(key)).rejects.toBeInstanceOf(TypeError);
    expect(send).not.toHaveBeenCalled();
  });

  it("asks for at most cap + 1 bytes and returns the body and ETag", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      Body: Readable.from([Buffer.from([1, 2]), Buffer.from([3])]),
      ETag: '"e1"',
    } as never);
    const read = await getImportBytes(KEY);
    expect(read).toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
      etag: '"e1"',
    });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toMatchObject({
      Bucket: "yg-private",
      Key: KEY,
      Range: `bytes=0-${MAX_IMPORT_BYTES}`,
    });
  });

  it("accepts exactly the cap", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      Body: Readable.from([Buffer.alloc(MAX_IMPORT_BYTES)]),
    } as never);
    const read = await getImportBytes(KEY);
    expect(read.ok && read.bytes.byteLength).toBe(MAX_IMPORT_BYTES);
  });

  it("refuses a body over the cap and stops reading at the chunk that crosses it", async () => {
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    let pulled = 0;
    // An endless body: a reader that buffered everything would never return.
    async function* endless() {
      for (;;) {
        pulled += 1;
        yield chunk;
      }
    }
    // highWaterMark 1: the stream reads ahead at most one chunk, so the
    // bound below measures readCapped, not the stream's buffering.
    const body = Readable.from(endless(), { highWaterMark: 1 });
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      Body: body,
    } as never);
    await expect(getImportBytes(KEY)).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
    // 30 MB / 8 MB: the 4th chunk crosses the cap.
    expect(pulled).toBeGreaterThanOrEqual(4);
    expect(pulled).toBeLessThanOrEqual(6);
    expect(body.destroyed).toBe(true);
  });

  it("refuses an over-cap body without a stream (SDK mixin only)", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      Body: {
        transformToByteArray: async () => new Uint8Array(MAX_IMPORT_BYTES + 1),
      },
    } as never);
    await expect(getImportBytes(KEY)).resolves.toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("reports a missing object and an empty one", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(
      notFound() as never,
    );
    await expect(getImportBytes(KEY)).resolves.toEqual({
      ok: false,
      reason: "not_found",
    });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(
      new S3ServiceException({
        name: "InvalidRange",
        $fault: "client",
        $metadata: { httpStatusCode: 416 },
        message: "range",
      }) as never,
    );
    await expect(getImportBytes(KEY)).resolves.toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("other errors pass through unchanged", async () => {
    const boom = new Error("network down");
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(boom as never);
    await expect(getImportBytes(KEY)).rejects.toBe(boom);
  });

  it("pins the version with If-Match; a replaced file is a StorageConditionError", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockRejectedValueOnce(preconditionFailed() as never);
    await expect(
      getImportBytes(KEY, { ifMatch: '"e1"' }),
    ).rejects.toBeInstanceOf(StorageConditionError);
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input).toMatchObject({
      IfMatch: '"e1"',
    });
  });

  it("an empty body is reported as empty", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValueOnce({
      Body: undefined,
    } as never);
    await expect(getImportBytes(KEY)).resolves.toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("deleteImportUpload deletes exactly that key", async () => {
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockResolvedValueOnce({} as never);
    await deleteImportUpload(KEY);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      Bucket: "yg-private",
      Key: KEY,
    });
  });
});

const DATASHEET_KEY = "datasheets/0b9c6f1e-2a4d-4c8b-9e7f-1a2b3c4d5e6f.xlsx";

describe("presignGet (datasheet download, ADR 0071)", () => {
  async function signed(fileName: string) {
    const get = await presignGet({ key: DATASHEET_KEY, fileName });
    return { get, url: new URL(get.url) };
  }

  it("is a 60 second GET on the account host for exactly that key", async () => {
    const { get, url } = await signed("Arc.xlsx");
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/yg-private/${DATASHEET_KEY}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(get.expiresIn).toBe(60);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("signs the xlsx content type and an attachment disposition", async () => {
    const { url } = await signed("Arc family.xlsx");
    expect(url.searchParams.get("response-content-type")).toBe(XLSX_MIME_TYPE);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="Arc family.xlsx"; filename*=UTF-8''Arc%20family.xlsx`,
    );
  });

  it("keeps a non-ASCII name in filename* and an ASCII fallback", async () => {
    const { url } = await signed("Lámpara 灯具 Ü.xlsx");
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="L_mpara __ _.xlsx"; filename*=UTF-8''L%C3%A1mpara%20%E7%81%AF%E5%85%B7%20%C3%9C.xlsx`,
    );
  });

  it.each([
    "imports/0b9c6f1e-2a4d-4c8b-9e7f-1a2b3c4d5e6f.xlsx",
    "incoming/0b9c6f1e-2a4d-4c8b-9e7f-1a2b3c4d5e6f.xlsx",
    "whistleblower/case-1/photo.jpg",
    "datasheets/../imports/x.xlsx",
    `${DATASHEET_KEY}?x=1`,
    "",
  ])("refuses to sign %j (not a stored datasheet key)", async (key) => {
    await expect(presignGet({ key, fileName: "a.xlsx" })).rejects.toThrow(
      TypeError,
    );
  });
});

describe("attachmentDisposition", () => {
  it.each<[string, string]>([
    [
      'a"b\\c.xlsx',
      `attachment; filename="a_b_c.xlsx"; filename*=UTF-8''a%22b_c.xlsx`,
    ],
    [
      "evil\r\nSet-Cookie: x=1.xlsx",
      `attachment; filename="evilSet-Cookie: x=1.xlsx"; filename*=UTF-8''evilSet-Cookie%3A%20x%3D1.xlsx`,
    ],
    [
      "it's (v2)*.xlsx",
      `attachment; filename="it's (v2)*.xlsx"; filename*=UTF-8''it%27s%20%28v2%29%2A.xlsx`,
    ],
    [
      "../../x.xlsx",
      `attachment; filename=".._.._x.xlsx"; filename*=UTF-8''.._.._x.xlsx`,
    ],
    [
      "\u0000\u001f\u007f",
      `attachment; filename="datasheet.xlsx"; filename*=UTF-8''datasheet.xlsx`,
    ],
    // C1 control characters are dropped too.
    [
      "a\u0085b\u009f.xlsx",
      `attachment; filename="ab.xlsx"; filename*=UTF-8''ab.xlsx`,
    ],
    // A lone surrogate becomes U+FFFD instead of making encodeURIComponent throw.
    [
      `${String.fromCharCode(0xd800)}x.xlsx`,
      `attachment; filename="_x.xlsx"; filename*=UTF-8''%EF%BF%BDx.xlsx`,
    ],
  ])("%j is safe in the header", (name, expected) => {
    const value = attachmentDisposition(name);
    expect(value).toBe(expected);
    // A header value: printable ASCII only, never CR/LF.
    expect(value).toMatch(/^[\x20-\x7e]+$/);
  });

  it("keeps an emoji (astral) name as UTF-8 in filename*", () => {
    expect(attachmentDisposition("💡.xlsx")).toBe(
      `attachment; filename="_.xlsx"; filename*=UTF-8''%F0%9F%92%A1.xlsx`,
    );
  });
});
