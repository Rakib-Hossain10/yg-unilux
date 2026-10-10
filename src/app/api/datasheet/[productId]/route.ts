// GET /api/datasheet/[productId]: the only way to a datasheet file (CLAUDE.md
// rule 2, plan Q9, ADR 0071). The product page and /my-downloads link here
// with a plain <a>, so every answer is a redirect or a short text page, and
// every answer is `Cache-Control: private, no-store`.
//
// Order of checks (each step answers before the next one runs):
//   0. a browser prefetch (Sec-Purpose/Purpose: prefetch)  → 204, nothing read
//   1. productId must be an ObjectId                      → 404
//   2. product published (draft/unknown = 404 for everyone, the admin too)
//      and a datasheet attached ("coming soon" is public) → 404
//   3. session from the database + checkDatasheetAccess:
//      signed out / temporary password / other role      → 303 /login?next=/product/<slug>
//      expired / banned                                  → 303 /request-access?renew=1&product=<id>
//   4. datasheet record exists                            → 404
//   5. per-user limit, 60/hour, admin exempt              → 429 (limiter down → 503)
//   6. presign (60 s), write the downloadLogs entry       → 503 if either fails
//   7.                                                    → 303 to the presigned URL
// Product existence is checked before the session because a published
// product (and whether it has a datasheet) is public anyway, and a draft must
// not send anyone to the login page. The datasheet record is read only for a
// viewer who may download, so nobody else learns whether it still exists.
// A database failure while reading the product or the session is a 503,
// never "signed out". The R2 key and the URL are never logged and never in a
// body. HEAD is 405 (Allow: GET), so it never runs the GET pipeline.

import { connection } from "next/server";

import {
  consumeDownload,
  findDatasheetFile,
  findDownloadProduct,
  recordDownload,
} from "@/lib/datasheet-download";
import {
  checkDatasheetAccess,
  getViewer,
  loginPathFor,
} from "@/lib/permissions";
import { RateLimitUnavailableError } from "@/lib/rate-limit";
import { objectIdSchema } from "@/lib/schemas/common";
import { presignGet } from "@/lib/storage";

// Mongoose, Better Auth and the S3 signer need Node APIs.
export const runtime = "nodejs";

const NO_STORE = "private, no-store";

/* A 303 (the browser follows it with a GET) that no cache keeps. */
function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": NO_STORE },
  });
}

/* A short plain-text page: the browser shows it as is, nothing to render. */
function text(
  status: 404 | 429 | 503,
  body: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_STORE,
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

const notFound = () => text(404, "Datasheet not found.\n");

const unavailable = () =>
  text(
    503,
    "Downloads are unavailable right now. Please try again shortly.\n",
    {
      "Retry-After": "60",
    },
  );

function tooMany(retryAfterSeconds: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const minutes = Math.ceil(seconds / 60);
  return text(
    429,
    `Too many downloads. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.\n`,
    { "Retry-After": String(seconds) },
  );
}

/* Error type only: never the message (it may echo a key or URL). */
function logProblem(what: string, error: unknown): void {
  const kind = error instanceof Error ? error.name : typeof error;
  console.error(`[datasheet] ${what}: ${kind}`);
}

function renewalPath(productId: string): string {
  const query = new URLSearchParams({ renew: "1", product: productId });
  return `/request-access?${query.toString()}`;
}

/*
 * A speculative request: Chromium sends `Sec-Purpose: prefetch` (or
 * `prefetch;prerender`), older browsers `Purpose: prefetch`, Firefox
 * `X-Moz: prefetch`, old Safari `X-Purpose: preview`. A download must cost a
 * slot, a presigned URL and a log row only when the person clicks.
 */
const PREFETCH_TOKEN = /(?:^|[\s,;])(?:prefetch|preview)(?:$|[\s,;=])/i;

function isPrefetch(headers: Headers): boolean {
  return ["sec-purpose", "purpose", "x-purpose", "x-moz"].some((name) =>
    PREFETCH_TOKEN.test(headers.get(name) ?? ""),
  );
}

/* Answers a prefetch with nothing: no lookup, no session read, no log. */
function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": NO_STORE },
  });
}

/*
 * HEAD would otherwise run GET (Next answers HEAD with the GET handler) and
 * count, presign and log a download nobody receives.
 */
export function HEAD(): Response {
  return new Response(null, {
    status: 405,
    headers: { Allow: "GET", "Cache-Control": NO_STORE },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ productId: string }> },
): Promise<Response> {
  await connection();
  if (isPrefetch(request.headers)) return noContent();
  const parsed = objectIdSchema.safeParse((await params).productId);
  if (!parsed.success) return notFound();

  let product;
  let viewer;
  try {
    [product, viewer] = await Promise.all([
      findDownloadProduct(parsed.data),
      getViewer(),
    ]);
  } catch (error) {
    logProblem("lookup failed", error);
    return unavailable();
  }
  if (!product || product.datasheetId === null) return notFound();

  const access = checkDatasheetAccess(viewer?.user, new Date());
  if (!access.ok) {
    switch (access.reason) {
      case "expired":
      case "banned":
        return seeOther(renewalPath(product.id));
      case "signed-out":
      case "must-change-password":
      case "not-allowed":
        return seeOther(loginPathFor(`/product/${product.slug}`));
    }
  }

  try {
    const file = await findDatasheetFile(product.datasheetId);
    if (!file) return notFound();

    // Counted only once there is a file to hand out. A later 503 (R2 or the
    // log write down) still costs one of the 60: accepted (ADR 0071).
    const limit = await consumeDownload(access.user);
    if (!limit.allowed) return tooMany(limit.retryAfterSeconds);

    const signed = await presignGet({
      key: file.storageKey,
      fileName: file.fileName,
    });
    // Log first: a download that can't be logged is refused (plan Q9).
    await recordDownload({
      userId: access.user.id,
      productId: product.id,
      datasheetId: file.id,
    });
    return seeOther(signed.url);
  } catch (error) {
    logProblem(
      error instanceof RateLimitUnavailableError
        ? "limiter unavailable"
        : "download refused",
      error,
    );
    return unavailable();
  }
}
