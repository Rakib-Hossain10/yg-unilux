// Phase 5 P4: GET /api/datasheet/[productId] end to end (rule 2, ADR 0071).
// An active customer gets a 303 to a 60 s presigned R2 GET that the R2 fake
// serves as an .xlsx attachment (bytes and file name intact), and a log row
// is written; a visitor is sent to /login with next=/product/<slug> and no
// row is written. Every answer is `private, no-store`. The redirect is
// followed by hand: page.route() does not see a navigation's redirected
// request, so a browser would try the real R2 host.

import { randomUUID } from "node:crypto";

import {
  type APIRequestContext,
  expect,
  request as playwrightRequest,
  test,
} from "@playwright/test";
import { type Db, type MongoClient, ObjectId } from "mongodb";

import { E2E_DOWNLOAD_CUSTOMER } from "./fixtures/accounts";
import { connectE2eDb } from "./fixtures/database";
import { putR2Object } from "./fixtures/providers";
import { E2E_FAKE_PROVIDERS_URL } from "./fixtures/providers-port";

const BASE_URL = "http://localhost:3000";
const XLSX =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILE_NAME = "Arc 系列 datasheet.xlsx";
// A zip local-file header plus a marker, enough to compare bytes.
const BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from(`e2e-datasheet-${randomUUID()}`),
]);

const productId = new ObjectId();
const datasheetId = new ObjectId();
const slug = `e2e-download-${productId.toHexString().slice(-8)}`;
const storageKey = `datasheets/${randomUUID()}.xlsx`;
const routePath = `/api/datasheet/${productId.toHexString()}`;

let client: MongoClient;
let db: Db;

test.beforeAll(async () => {
  client = await connectE2eDb();
  db = client.db();
  const now = new Date();
  await db.collection("datasheets").insertOne({
    _id: datasheetId,
    storageKey,
    fileName: FILE_NAME,
    size: BYTES.length,
    mimeType: XLSX,
    uploadedBy: new ObjectId(),
    createdAt: now,
    updatedAt: now,
  });
  // The route reads only _id, slug, status and datasheetId.
  await db.collection("products").insertOne({
    _id: productId,
    name: "E2E Download",
    slug,
    status: "published",
    mainCategory: new ObjectId(),
    variants: [{ modelNo: `E2E-DL-${productId.toHexString().slice(-6)}` }],
    datasheetId,
    createdAt: now,
    updatedAt: now,
  });
  await putR2Object(storageKey, BYTES);
});

test.afterAll(async () => {
  await client?.close();
});

const logCount = () =>
  db.collection("downloadLogs").countDocuments({ product: productId });

/** An API context signed in as the download customer. */
async function signedInRequest(): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const response = await context.post("/api/auth/sign-in/email", {
    data: {
      email: E2E_DOWNLOAD_CUSTOMER.email,
      password: E2E_DOWNLOAD_CUSTOMER.password,
    },
    headers: { origin: BASE_URL },
  });
  expect(response.status()).toBe(200);
  return context;
}

test("a visitor is sent to sign in and nothing is logged", async ({
  request,
}) => {
  const before = await logCount();
  const response = await request.get(routePath, { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers()["cache-control"]).toBe("private, no-store");
  expect(response.headers()["location"]).toBe(
    `/login?next=${encodeURIComponent(`/product/${slug}`)}`,
  );
  expect(await logCount()).toBe(before);
});

test("an active customer gets a 60 s presigned GET the bucket serves", async () => {
  const context = await signedInRequest();
  try {
    const before = await logCount();
    const response = await context.get(routePath, { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    const location = new URL(response.headers()["location"] ?? "");
    expect(location.hostname).toMatch(/\.r2\.cloudflarestorage\.com$/);
    expect(location.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(await logCount()).toBe(before + 1);

    // Follow the redirect the way R2 would answer it (through the fake).
    const file = await fetch(
      `${E2E_FAKE_PROVIDERS_URL}${location.pathname}${location.search}`,
      { headers: { "x-e2e-host": location.hostname } },
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe(XLSX);
    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename="Arc __ datasheet.xlsx"; filename*=UTF-8''${encodeURIComponent(FILE_NAME)}`,
    );
    expect(Buffer.from(await file.arrayBuffer()).equals(BYTES)).toBe(true);

    // A URL past its 60 s is refused by the bucket.
    const stale = new URL(location);
    stale.searchParams.set("X-Amz-Date", "20200101T000000Z");
    const expired = await fetch(
      `${E2E_FAKE_PROVIDERS_URL}${stale.pathname}${stale.search}`,
      { headers: { "x-e2e-host": stale.hostname } },
    );
    expect(expired.status).toBe(403);
  } finally {
    await context.dispose();
  }
});
