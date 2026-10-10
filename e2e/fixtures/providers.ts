// Browser side of the R2/Cloudinary fakes. The admin pages upload straight to
// https://<account>.r2.cloudflarestorage.com (presigned PUT) and
// https://api.cloudinary.com (signed POST); no real network is used. page.route
// catches those calls and forwards them to the in-memory fakes that the test
// server runs (e2e/fake-providers), so the server's own HEAD/GET/COPY/Admin API
// calls then see the same bytes. The admin CSP still applies to the page, so a
// host missing from connect-src would fail here exactly as it would in a browser.

import type { Page, Route } from "@playwright/test";

import { E2E_FAKE_PROVIDERS_URL } from "./providers-port";

const R2 = /^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\//;
const CLOUDINARY_API = /^https:\/\/api\.cloudinary\.com\//;
const CLOUDINARY_IMAGES = /^https:\/\/res\.cloudinary\.com\//;

// A 1x1 PNG: a valid image for previews and for uploads.
export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Each call gets a distinct PNG (extra trailing bytes) so files differ. */
export function pngFile(name: string, extra = 0) {
  return {
    name,
    mimeType: "image/png",
    buffer: Buffer.concat([PNG_1X1, Buffer.alloc(extra, 1)]),
  };
}

function corsHeaders(route: Route): Record<string, string> {
  const origin = route.request().headers()["origin"] ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
  };
}

async function forward(route: Route, host: string): Promise<void> {
  const request = route.request();
  if (request.method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: corsHeaders(route) });
    return;
  }
  const url = new URL(request.url());
  const headers: Record<string, string> = { "x-e2e-host": host };
  const contentType = request.headers()["content-type"];
  if (contentType) headers["content-type"] = contentType;
  const body = request.postDataBuffer();
  const reply = await fetch(
    `${E2E_FAKE_PROVIDERS_URL}${url.pathname}${url.search}`,
    {
      method: request.method(),
      headers,
      ...(body ? { body: new Uint8Array(body) } : {}),
    },
  );
  await route.fulfill({
    status: reply.status,
    headers: {
      ...corsHeaders(route),
      "content-type": reply.headers.get("content-type") ?? "text/plain",
      // A presigned datasheet GET answers as an attachment (ADR 0071).
      ...(reply.headers.get("content-disposition")
        ? {
            "content-disposition":
              reply.headers.get("content-disposition") ?? "",
          }
        : {}),
    },
    body: Buffer.from(await reply.arrayBuffer()),
  });
}

/** Sends the page's R2 and Cloudinary traffic to the fakes. Call before goto. */
export async function stubProviders(page: Page): Promise<void> {
  await page.route(R2, (route) =>
    forward(route, new URL(route.request().url()).hostname),
  );
  await page.route(CLOUDINARY_API, (route) =>
    forward(route, "api.cloudinary.com"),
  );
  // Image previews: any stored id shows the same tiny picture.
  await page.route(CLOUDINARY_IMAGES, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1X1 }),
  );
}

/** Makes every provider call from this page fail like a dropped connection. */
export async function breakProviders(page: Page): Promise<void> {
  await page.route(R2, (route) => route.abort("connectionrefused"));
  await page.route(CLOUDINARY_API, (route) => route.abort("connectionrefused"));
}

async function control<T>(path: string, init?: RequestInit): Promise<T> {
  const reply = await fetch(`${E2E_FAKE_PROVIDERS_URL}/__e2e/${path}`, init);
  return (await reply.json()) as T;
}

/** Does the private bucket fake hold this object, and how big is it? */
export function r2Object(key: string) {
  return control<{ exists: boolean; size: number }>(
    `object?key=${encodeURIComponent(key)}`,
  );
}

/** Seeds an object in the bucket fake (a datasheet's file). */
export async function putR2Object(key: string, bytes: Buffer): Promise<void> {
  await control(`put-object?key=${encodeURIComponent(key)}`, {
    method: "POST",
    body: new Uint8Array(bytes),
  });
}

/** Makes deleting this object fail in the bucket fake ("storage down"). */
export async function failR2Delete(key: string): Promise<void> {
  await control(`fail-delete?key=${encodeURIComponent(key)}`);
}

/** Does the Cloudinary fake hold this image? */
export function cloudinaryImage(publicId: string) {
  return control<{ exists: boolean; bytes: number }>(
    `image?key=${encodeURIComponent(publicId)}`,
  );
}
