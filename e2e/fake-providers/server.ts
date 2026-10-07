// In-memory stand-in for Cloudflare R2 (S3 API) and Cloudinary (upload + Admin
// API) for the Playwright run. Started by e2e/test-server.ts on 127.0.0.1; the
// app's server reaches it through e2e/fake-providers/preload.mjs, and the
// browser's own calls are forwarded here by e2e/fixtures/providers.ts. Holds
// bytes in memory only; nothing real is contacted and nothing is persisted.

import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

interface StoredObject {
  bytes: Buffer;
  contentType: string;
  lastModified: Date;
}

interface StoredImage {
  bytes: number;
  format: string;
  createdAt: Date;
}

const objects = new Map<string, StoredObject>();
const images = new Map<string, StoredImage>();
/** Object keys whose DELETE must fail (to test "storage unreachable"). */
const failingDeletes = new Set<string>();

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Buffer = "",
  headers: Record<string, string | number> = {},
): void {
  response.writeHead(status, headers);
  response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, JSON.stringify(value), {
    "content-type": "application/json",
  });
}

const xmlEscape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const XML_HEADER = { "content-type": "application/xml" };

function s3Error(response: ServerResponse, status: number, code: string): void {
  send(
    response,
    status,
    `<?xml version="1.0"?><Error><Code>${code}</Code><Message>e2e fake</Message></Error>`,
    XML_HEADER,
  );
}

/* R2's ETag for a single-part upload: the quoted MD5 of the bytes. */
function etagOf(bytes: Buffer): string {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

/* An If-Match / x-amz-copy-source-if-match condition that the object fails. */
function failsMatch(
  condition: string | string[] | undefined,
  object: StoredObject,
): boolean {
  if (typeof condition !== "string") return false;
  return condition !== "*" && condition !== etagOf(object.bytes);
}

function detectFormat(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "jpg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF") return "webp";
  return "bin";
}

/* ---- S3 (R2): path-style /<bucket>/<key> ---- */

async function handleS3(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const [, , ...rest] = url.pathname.split("/");
  const key = decodeURIComponent(rest.join("/"));
  const method = request.method ?? "GET";

  if (method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const items = [...objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(
        ([k, o]) =>
          `<Contents><Key>${xmlEscape(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><Size>${o.bytes.length}</Size></Contents>`,
      )
      .join("");
    return send(
      response,
      200,
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>e2e</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${objects.size}</KeyCount><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`,
      XML_HEADER,
    );
  }

  if (method === "PUT") {
    const copySource = request.headers["x-amz-copy-source"];
    if (typeof copySource === "string") {
      // "<bucket>/<key>", URL-encoded.
      const [, ...from] = decodeURIComponent(copySource).split("/");
      const source = objects.get(from.join("/"));
      if (!source) return s3Error(response, 404, "NoSuchKey");
      if (failsMatch(request.headers["x-amz-copy-source-if-match"], source)) {
        return s3Error(response, 412, "PreconditionFailed");
      }
      objects.set(key, { ...source, lastModified: new Date() });
      return send(
        response,
        200,
        `<?xml version="1.0"?><CopyObjectResult><ETag>${etagOf(source.bytes)}</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`,
        XML_HEADER,
      );
    }
    const bytes = await readBody(request);
    objects.set(key, {
      bytes,
      contentType: String(
        request.headers["content-type"] ?? "application/octet-stream",
      ),
      lastModified: new Date(),
    });
    return send(response, 200, "", { etag: etagOf(bytes) });
  }

  const found = objects.get(key);
  if (method === "HEAD") {
    if (!found) return send(response, 404);
    return send(response, 200, "", {
      "content-length": found.bytes.length,
      "content-type": found.contentType,
      etag: etagOf(found.bytes),
    });
  }
  if (method === "GET") {
    if (!found) return s3Error(response, 404, "NoSuchKey");
    if (failsMatch(request.headers["if-match"], found)) {
      return s3Error(response, 412, "PreconditionFailed");
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(
      String(request.headers.range ?? ""),
    );
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), found.bytes.length - 1);
      const part = found.bytes.subarray(start, end + 1);
      return send(response, 206, part, {
        "content-type": found.contentType,
        "content-length": part.length,
        "content-range": `bytes ${start}-${end}/${found.bytes.length}`,
        etag: etagOf(found.bytes),
      });
    }
    return send(response, 200, found.bytes, {
      "content-type": found.contentType,
      "content-length": found.bytes.length,
      etag: etagOf(found.bytes),
    });
  }
  if (method === "DELETE") {
    if (failingDeletes.has(key)) return s3Error(response, 503, "SlowDown");
    objects.delete(key);
    return send(response, 204);
  }
  return send(response, 405);
}

/* ---- Cloudinary: /v1_1/<cloud>/... ---- */

/* A field of a multipart or urlencoded body, read as text. */
function bodyField(body: Buffer, name: string): string | null {
  const text = body.toString("latin1");
  const multipart = new RegExp(
    `name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`,
  ).exec(text);
  if (multipart) return multipart[1] ?? null;
  const form = new RegExp(`(?:^|&)${name}=([^&]*)`).exec(text);
  return form ? decodeURIComponent((form[1] ?? "").replace(/\+/g, " ")) : null;
}

/* The bytes of the multipart part named "file". */
function filePart(body: Buffer): Buffer | null {
  const marker = body.indexOf('name="file"');
  if (marker === -1) return null;
  const start = body.indexOf("\r\n\r\n", marker);
  if (start === -1) return null;
  const end = body.lastIndexOf("\r\n--");
  return body.subarray(start + 4, end > start ? end : body.length);
}

async function handleCloudinary(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const method = request.method ?? "GET";
  // /v1_1/<cloud>/<rest>
  const rest = url.pathname.split("/").slice(3).join("/");

  if (method === "POST" && rest === "image/upload") {
    const body = await readBody(request);
    const publicId = bodyField(body, "public_id");
    const file = filePart(body);
    if (!publicId || !file) {
      return json(response, 400, { error: { message: "Missing parameters" } });
    }
    images.set(publicId, {
      bytes: file.length,
      format: detectFormat(file),
      createdAt: new Date(),
    });
    return json(response, 200, {
      public_id: publicId,
      bytes: file.length,
      format: detectFormat(file),
      resource_type: "image",
    });
  }

  if (method === "GET" && rest.startsWith("resources/image/upload/")) {
    const id = decodeURIComponent(rest.slice("resources/image/upload/".length));
    const found = images.get(id);
    if (!found) {
      return json(response, 404, {
        error: { message: `Resource not found - ${id}` },
      });
    }
    return json(response, 200, {
      public_id: id,
      resource_type: "image",
      format: found.format,
      bytes: found.bytes,
      width: 1,
      height: 1,
    });
  }

  if (method === "GET" && rest === "resources/image/upload") {
    const prefix = url.searchParams.get("prefix") ?? "";
    return json(response, 200, {
      resources: [...images.entries()]
        .filter(([id]) => id.startsWith(prefix))
        .map(([id, i]) => ({
          public_id: id,
          created_at: i.createdAt.toISOString(),
        })),
    });
  }

  if (method === "POST" && rest === "image/destroy") {
    const body = await readBody(request);
    const publicId = bodyField(body, "public_id") ?? "";
    const existed = images.delete(publicId);
    return json(response, 200, { result: existed ? "ok" : "not found" });
  }

  return json(response, 404, { error: { message: "not handled by the fake" } });
}

/* ---- Control endpoints for specs (never reached by the app) ---- */

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const what = url.pathname.replace("/__e2e/", "");
  const key = url.searchParams.get("key") ?? "";
  if (what === "fail-delete") {
    failingDeletes.add(key);
    return json(response, 200, { ok: true });
  }
  if (what === "object") {
    const found = objects.get(key);
    return json(response, 200, {
      exists: found !== undefined,
      size: found?.bytes.length ?? 0,
    });
  }
  if (what === "put-object") {
    // A spec seeds an object (e.g. a datasheet's file) without the browser.
    objects.set(key, {
      bytes: await readBody(request),
      contentType: String(request.headers["content-type"] ?? "text/plain"),
      lastModified: new Date(),
    });
    return json(response, 200, { ok: true });
  }
  if (what === "image") {
    const found = images.get(key);
    return json(response, 200, {
      exists: found !== undefined,
      bytes: found?.bytes ?? 0,
    });
  }
  return json(response, 404, { error: "unknown control call" });
}

export function startFakeProviders(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://fake.invalid");
        if (url.pathname.startsWith("/__e2e/")) {
          return await handleControl(request, response, url);
        }
        const host = String(
          request.headers["x-e2e-host"] ?? request.headers.host ?? "",
        );
        if (/api\.cloudinary\.com$/.test(host)) {
          return await handleCloudinary(request, response, url);
        }
        if (/r2\.cloudflarestorage\.com$/.test(host)) {
          return await handleS3(request, response, url);
        }
        return send(response, 404);
      } catch {
        if (!response.headersSent) send(response, 500);
        else response.end();
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: never reachable from another machine.
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
