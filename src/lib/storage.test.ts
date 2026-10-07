// Tests for the R2 storage module that need no network: a presigned PUT is
// path-style on the account host, short-lived, and signs type and length;
// HEAD returns the ETag, and the conditional read/copy send it and turn a 412
// into StorageConditionError (gate E L-1).

import {
  CopyObjectCommand,
  GetObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  copyObject,
  getObjectBytes,
  headObject,
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
