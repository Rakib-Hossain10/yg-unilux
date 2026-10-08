// The only module that talks to the private Cloudflare R2 bucket (ADR 0009,
// 0045). Everything is private: no public URL is ever built here. Credentials
// come only from env.r2(). Callers (admin datasheet service, bulk import
// staging, later the download route and whistleblower uploads) never see the
// S3 SDK.

import "server-only";

import { randomUUID } from "node:crypto";

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  IMPORT_UPLOAD_TTL_SECONDS,
  MAX_IMPORT_BYTES,
  R2_IMPORTS_PREFIX,
  XLSX_MIME_TYPE,
} from "./constants";
import { env } from "./env";
import { IMPORT_KEY_PATTERN } from "./schemas/import";

/** A presigned PUT is valid for 5 minutes (Phase 2 plan, ADR 0045). */
export const PRESIGNED_PUT_TTL_SECONDS = 300;

interface Client {
  s3: S3Client;
  bucket: string;
}

/*
 * One client per credential set. Built lazily (nothing is read at import
 * time) and rebuilt if the env changes (tests, a rotated key).
 */
let cached: { id: string; client: Client } | undefined;

function client(): Client {
  const r2 = env.r2();
  const id = `${r2.accountId}|${r2.accessKeyId}|${r2.bucket}`;
  if (cached?.id === id) return cached.client;
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    // Path-style: the presigned host is exactly
    // <account>.r2.cloudflarestorage.com, the one host the admin CSP allows
    // (ADR 0045 point 6). Virtual-hosted style would put the bucket in the host.
    forcePathStyle: true,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
    // R2 does not accept the SDK's default CRC32 trailer on a browser PUT.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  cached = { id, client: { s3, bucket: r2.bucket } };
  return cached.client;
}

/** True when the S3 error means "no such object". */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return (
    error.$metadata.httpStatusCode === 404 ||
    error.name === "NotFound" ||
    error.name === "NoSuchKey"
  );
}

export interface PresignedPut {
  url: string;
  /** Headers the browser must send with the PUT (they are signed). */
  headers: { "Content-Type": string };
  expiresIn: number;
}

/**
 * A presigned PUT for one object. `ContentType` and `ContentLength` are part
 * of the signature, so the browser can upload only a file of exactly that
 * size and type to exactly that key.
 */
export async function presignPut(options: {
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<PresignedPut> {
  return signPut(options, PRESIGNED_PUT_TTL_SECONDS);
}

async function signPut(
  options: { key: string; contentType: string; contentLength: number },
  expiresIn: number,
): Promise<PresignedPut> {
  const { s3, bucket } = client();
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: bucket,
      Key: options.key,
      ContentType: options.contentType,
      ContentLength: options.contentLength,
    }),
    {
      expiresIn,
      signableHeaders: new Set(["content-type", "content-length"]),
    },
  );
  return {
    url,
    headers: { "Content-Type": options.contentType },
    expiresIn,
  };
}

/** A presigned import PUT plus the server-chosen key to pass back later. */
export interface ImportUploadTicket extends PresignedPut {
  /** `imports/<uuid v4>.xlsx`; preview and commit read the file from here. */
  key: string;
}

/**
 * A presigned PUT for one bulk import file (Phase 3). The key is chosen here
 * (`imports/<uuid v4>.xlsx`), never by the browser; the type is always the
 * .xlsx MIME type and the exact length is signed, at most MAX_IMPORT_BYTES
 * (30 MB). Valid for IMPORT_UPLOAD_TTL_SECONDS. The caller has already
 * Zod-checked the request; a value outside these limits is a programming
 * error and throws (TypeError / RangeError) before anything is signed.
 */
export async function presignImportUpload(options: {
  contentType: string;
  contentLength: number;
}): Promise<ImportUploadTicket> {
  if (options.contentType !== XLSX_MIME_TYPE) {
    throw new TypeError("presignImportUpload signs only the .xlsx MIME type");
  }
  const { contentLength } = options;
  if (
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > MAX_IMPORT_BYTES
  ) {
    throw new RangeError(
      `presignImportUpload needs a whole size from 1 to ${MAX_IMPORT_BYTES} bytes`,
    );
  }
  const key = `${R2_IMPORTS_PREFIX}${randomUUID()}.xlsx`;
  const put = await signPut(
    { key, contentType: XLSX_MIME_TYPE, contentLength },
    IMPORT_UPLOAD_TTL_SECONDS,
  );
  return { ...put, key };
}

/**
 * The object changed since its ETag was read (HTTP 412 on an If-Match or
 * CopySourceIfMatch condition). Carries no request detail.
 */
export class StorageConditionError extends Error {
  constructor() {
    super("The stored object changed while it was being processed.");
    this.name = "StorageConditionError";
  }
}

/* True when the S3 error is a failed If-Match / CopySourceIfMatch. */
function isPreconditionFailed(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return (
    error.$metadata.httpStatusCode === 412 ||
    error.name === "PreconditionFailed"
  );
}

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
  /**
   * The object's ETag exactly as R2 returns it (quoted). Pass it as `ifMatch`
   * to read and copy exactly this version. Undefined only if R2 omits it.
   */
  etag: string | undefined;
}

/** Size, type and ETag of an object, or null when it does not exist. */
export async function headObject(key: string): Promise<ObjectHead | null> {
  const { s3, bucket } = client();
  try {
    const out = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      size: out.ContentLength ?? 0,
      contentType: out.ContentType,
      etag: out.ETag,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function bodyToBytes(
  body: { transformToByteArray(): Promise<Uint8Array> } | undefined,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  return body.transformToByteArray();
}

/**
 * Bytes `start..end` (inclusive) of an object, e.g. the first four bytes for
 * a signature check. Null when the object does not exist.
 */
export async function getRange(
  key: string,
  start: number,
  end: number,
  options: { ifMatch?: string } = {},
): Promise<Uint8Array | null> {
  const { s3, bucket } = client();
  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
        IfMatch: options.ifMatch,
      }),
    );
    return await bodyToBytes(out.Body);
  } catch (error) {
    if (isNotFound(error)) return null;
    if (isPreconditionFailed(error)) throw new StorageConditionError();
    throw error;
  }
}

/**
 * The whole object in memory. The caller passes the size it already got from
 * headObject(), and `maxBytes` caps the read: the request asks for at most
 * `maxBytes + 1` bytes, so an object that grew after the check can't fill
 * memory. With `ifMatch` (the ETag from headObject) the read fails with
 * StorageConditionError if the object was replaced since the HEAD. Returns
 * null when it does not exist.
 */
export async function getObjectBytes(
  key: string,
  maxBytes: number,
  options: { ifMatch?: string } = {},
): Promise<Uint8Array | null> {
  return getRange(key, 0, maxBytes, options);
}

/**
 * Copies one object inside the bucket (server side, nothing is downloaded),
 * only if the source still has the ETag `ifMatch` (CopySourceIfMatch). So the
 * copy is exactly the version the caller read and checked; a source replaced
 * in between makes it throw StorageConditionError and nothing is written.
 */
export async function copyObject(
  from: string,
  to: string,
  options: { ifMatch: string },
): Promise<void> {
  const { s3, bucket } = client();
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        // Keys are ours (uuid based), but encode anyway as the header needs it.
        CopySource: encodeURIComponent(`${bucket}/${from}`).replace(
          /%2F/g,
          "/",
        ),
        CopySourceIfMatch: options.ifMatch,
        Key: to,
      }),
    );
  } catch (error) {
    if (isPreconditionFailed(error)) throw new StorageConditionError();
    throw error;
  }
}

/** Deletes one object. Deleting a missing object is not an error. */
export async function deleteObject(key: string): Promise<void> {
  const { s3, bucket } = client();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date | undefined;
}

/** Every object under `prefix` (follows pagination). For the orphan sweep. */
export async function listObjects(prefix: string): Promise<ListedObject[]> {
  const { s3, bucket } = client();
  const found: ListedObject[] = [];
  let token: string | undefined;
  do {
    const out = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const item of out.Contents ?? []) {
      if (item.Key === undefined) continue;
      found.push({
        key: item.Key,
        size: item.Size ?? 0,
        lastModified: item.LastModified,
      });
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token !== undefined);
  return found;
}

// ---------------------------------------------------------------------------
// Bulk import staging (Phase 3)
// ---------------------------------------------------------------------------

function assertImportKey(key: string): void {
  if (!IMPORT_KEY_PATTERN.test(key)) {
    throw new TypeError("Not a staged import key");
  }
}

/* True when the S3 error is "range not satisfiable" (a zero-byte object). */
function isInvalidRange(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return (
    error.$metadata.httpStatusCode === 416 || error.name === "InvalidRange"
  );
}

type ResponseBody =
  | {
      transformToByteArray(): Promise<Uint8Array>;
    }
  | undefined;

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/**
 * Reads a response body but never holds more than `cap` bytes: a stream is
 * consumed chunk by chunk and abandoned (which destroys it) as soon as the
 * running total passes the cap. Returns null when the body is larger.
 */
async function readCapped(
  body: ResponseBody,
  cap: number,
): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  if (!isAsyncIterable(body)) {
    const bytes = await body.transformToByteArray();
    return bytes.byteLength > cap ? null : bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("Unexpected chunk type in the storage response");
    }
    total += chunk.byteLength;
    // Leaving the loop calls the iterator's return(), which destroys the stream.
    if (total > cap) return null;
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type ImportBytes =
  | {
      ok: true;
      bytes: Uint8Array;
      /** The ETag of the version read (quoted, as R2 returns it). */
      etag: string | undefined;
    }
  | {
      ok: false;
      /**
       * `not_found`: never uploaded, expired or already swept/finished;
       * `too_large`: more than MAX_IMPORT_BYTES; `empty`: zero bytes.
       */
      reason: "not_found" | "too_large" | "empty";
    };

/**
 * The staged import file at `key`, read with a hard cap of MAX_IMPORT_BYTES.
 * The GET asks only for the first cap + 1 bytes, and the body is counted
 * while it streams, so an object that is (or grew) larger is refused without
 * ever buffering more than the cap. With `ifMatch` (the ETag an earlier read
 * returned, e.g. the preview's) the read fails with StorageConditionError if
 * the object was replaced since, so a commit sees exactly the previewed file.
 * A key that is not `imports/<uuid>.xlsx` throws TypeError before any
 * request (callers Zod-check it first).
 */
export async function getImportBytes(
  key: string,
  options: { ifMatch?: string } = {},
): Promise<ImportBytes> {
  assertImportKey(key);
  const { s3, bucket } = client();
  let out;
  try {
    out = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${MAX_IMPORT_BYTES}`,
        IfMatch: options.ifMatch,
      }),
    );
  } catch (error) {
    if (isNotFound(error)) return { ok: false, reason: "not_found" };
    if (isPreconditionFailed(error)) throw new StorageConditionError();
    if (isInvalidRange(error)) return { ok: false, reason: "empty" };
    throw error;
  }
  const bytes = await readCapped(out.Body, MAX_IMPORT_BYTES);
  if (bytes === null) return { ok: false, reason: "too_large" };
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  return { ok: true, bytes, etag: out.ETag };
}

/**
 * Deletes a staged import file (after the last batch, or when the admin
 * starts over). Only `imports/<uuid>.xlsx` keys; anything else throws
 * TypeError. A missing object is not an error.
 */
export async function deleteImportUpload(key: string): Promise<void> {
  assertImportKey(key);
  await deleteObject(key);
}
