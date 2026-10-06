// The only module that talks to the private Cloudflare R2 bucket (ADR 0009,
// 0045). Everything is private: no public URL is ever built here. Credentials
// come only from env.r2(). Callers (admin datasheet service, later the
// download route and whistleblower uploads) never see the S3 SDK.

import "server-only";

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

import { env } from "./env";

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
      expiresIn: PRESIGNED_PUT_TTL_SECONDS,
      signableHeaders: new Set(["content-type", "content-length"]),
    },
  );
  return {
    url,
    headers: { "Content-Type": options.contentType },
    expiresIn: PRESIGNED_PUT_TTL_SECONDS,
  };
}

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
}

/** Size and type of an object, or null when it does not exist. */
export async function headObject(key: string): Promise<ObjectHead | null> {
  const { s3, bucket } = client();
  try {
    const out = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return { size: out.ContentLength ?? 0, contentType: out.ContentType };
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
): Promise<Uint8Array | null> {
  const { s3, bucket } = client();
  try {
    const out = await s3.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=${start}-${end}`,
      }),
    );
    return await bodyToBytes(out.Body);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * The whole object in memory. The caller passes the size it already got from
 * headObject(), and `maxBytes` caps the read: the request asks for at most
 * `maxBytes + 1` bytes, so an object that grew after the check can't fill
 * memory. Returns null when it does not exist.
 */
export async function getObjectBytes(
  key: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  return getRange(key, 0, maxBytes);
}

/** Copies one object inside the bucket (server side, nothing is downloaded). */
export async function copyObject(from: string, to: string): Promise<void> {
  const { s3, bucket } = client();
  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      // Keys are ours (uuid based), but encode anyway as the header needs it.
      CopySource: encodeURIComponent(`${bucket}/${from}`).replace(/%2F/g, "/"),
      Key: to,
    }),
  );
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
