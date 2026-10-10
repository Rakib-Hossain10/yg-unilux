// Tests for GET /api/datasheet/[productId] (rule 2, plan Q9, ADR 0071) with
// REAL Better Auth sessions on the memory replica set: the viewer × product
// matrix (exact status, Location and `private, no-store`), the presigned
// URL (60 s, xlsx type, RFC 5987 name), log-before-redirect and fail closed,
// the per-user limit (61st refused, admin exempt) and that no answer or log
// line carries the storage key or the URL.

import { Types } from "mongoose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { XLSX_MIME_TYPE } from "@/lib/constants";
import { buildKey, hashUserId } from "@/lib/rate-limit";
import { DatasheetModel, DownloadLogModel, ProductModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import {
  AUTH_BASE,
  seedUserFields,
  setupAuthHarness,
  signedInAdmin,
  signIn,
} from "../../../../../test/helpers/auth-harness";
import { testPublicId } from "../../../../../test/helpers/public-ids";

import { GET, HEAD } from "./route";

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("next/server", () => ({ connection: async () => undefined }));

const harness = setupAuthHarness("yg_datasheet_route_test");

const DAY = 86_400_000;
const STORAGE_KEY = "datasheets/2f1e6c9a-0b7d-4c55-9a51-7d3e8f0a1b2c.xlsx";
const FILE_NAME = "Arc 系列 datasheet.xlsx";

const ids = {
  category: new Types.ObjectId(),
  published: new Types.ObjectId(),
  draft: new Types.ObjectId(),
  noSheet: new Types.ObjectId(),
  rowMissing: new Types.ObjectId(),
  datasheet: new Types.ObjectId(),
  missingDatasheet: new Types.ObjectId(),
  uploader: new Types.ObjectId(),
};
const hex = (id: Types.ObjectId) => id.toHexString();

const PRODUCTS = {
  published: hex(ids.published),
  draft: hex(ids.draft),
  unknown: hex(new Types.ObjectId()),
  noSheet: hex(ids.noSheet),
  rowMissing: hex(ids.rowMissing),
  badId: "not-an-id",
} as const;
type ProductCase = keyof typeof PRODUCTS;

const SLUGS: Partial<Record<ProductCase, string>> = {
  published: "arc-ar-013a",
  rowMissing: "ghost-gh-001",
};

/** Cookie headers per viewer, filled in beforeAll. */
const cookies: Record<string, string> = {};
const userIds: Record<string, string> = {};

async function makeCustomer(
  name: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const email = `${name}@datasheet-route.test`;
  const password = `${name}-password-123456`;
  const { user } = await harness.auth.api.createUser({
    body: {
      email,
      password,
      name,
      role: "customer",
      data: { mustChangePassword: false, accessExpiresAt: null },
    },
  });
  cookies[name] = await signIn(email, password);
  userIds[name] = user.id;
  // States a sign-in would refuse (ban) or Better Auth would not create (an
  // unknown role) are seeded after the session exists.
  if (Object.keys(fields).length > 0) await seedUserFields(user.id, fields);
}

beforeAll(async () => {
  vi.stubEnv("R2_ACCOUNT_ID", "acct123");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIATESTKEY");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret-secret-secret");
  vi.stubEnv("R2_BUCKET", "yg-private");

  const base = {
    mainCategory: ids.category,
    status: "published" as const,
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" as const }],
  };
  await DatasheetModel.create({
    _id: ids.datasheet,
    storageKey: STORAGE_KEY,
    fileName: FILE_NAME,
    size: 1234,
    mimeType: XLSX_MIME_TYPE,
    uploadedBy: ids.uploader,
  });
  await ProductModel.create([
    {
      ...base,
      _id: ids.published,
      name: "Arc",
      slug: "arc-ar-013a",
      variants: [{ modelNo: "AR-013A1" }],
      datasheetId: ids.datasheet,
    },
    {
      ...base,
      _id: ids.draft,
      name: "Draft",
      slug: "draft-dr-001",
      status: "draft" as const,
      variants: [{ modelNo: "DR-001" }],
      datasheetId: ids.datasheet,
    },
    {
      ...base,
      _id: ids.noSheet,
      name: "Solo",
      slug: "solo-so-001",
      variants: [{ modelNo: "SO-001" }],
    },
    {
      ...base,
      _id: ids.rowMissing,
      name: "Ghost",
      slug: "ghost-gh-001",
      variants: [{ modelNo: "GH-001" }],
      datasheetId: ids.missingDatasheet,
    },
  ]);

  const now = Date.now();
  await makeCustomer("active", { accessExpiresAt: new Date(now + 30 * DAY) });
  await makeCustomer("noexpiry");
  await makeCustomer("expired", { accessExpiresAt: new Date(now - 1000) });
  await makeCustomer("banned", { banned: true, banExpires: null });
  await makeCustomer("temp", { mustChangePassword: true });
  await makeCustomer("banended", {
    banned: true,
    banExpires: new Date(now - DAY),
  });
  await makeCustomer("staff", { role: "staff" });
  await makeCustomer("limited");
  await makeCustomer("logfail");

  const admin = await signedInAdmin(harness, "admin@datasheet-route.test");
  cookies.admin = admin.headers.get("cookie") ?? "";
  userIds.admin = admin.id;
  const tempAdmin = await signedInAdmin(
    harness,
    "temp-admin@datasheet-route.test",
  );
  cookies.tempAdmin = tempAdmin.headers.get("cookie") ?? "";
  userIds.tempAdmin = tempAdmin.id;
  await seedUserFields(tempAdmin.id, { mustChangePassword: true });
}, 120_000);

beforeEach(() => {
  vi.stubEnv("R2_ACCOUNT_ID", "acct123");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIATESTKEY");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret-secret-secret");
  vi.stubEnv("R2_BUCKET", "yg-private");
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(viewer: string | null, productId: string) {
  request.headers = new Headers(
    viewer === null ? {} : { cookie: cookies[viewer] ?? "" },
  );
  return GET(new Request(`${AUTH_BASE}/api/datasheet/${productId}`), {
    params: Promise.resolve({ productId }),
  });
}

type Expected = "file" | "login" | "renew" | 404;

function expectAnswer(
  response: Response,
  expected: Expected,
  product: ProductCase,
): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const location = response.headers.get("location");
  if (expected === 404) {
    expect(response.status).toBe(404);
    expect(location).toBeNull();
    return;
  }
  expect(response.status).toBe(303);
  if (expected === "login") {
    expect(location).toBe(
      `/login?next=${encodeURIComponent(`/product/${SLUGS[product] ?? "?"}`)}`,
    );
  } else if (expected === "renew") {
    expect(location).toBe(
      `/request-access?renew=1&product=${PRODUCTS[product]}`,
    );
  } else {
    const url = new URL(location ?? "");
    expect(url.origin).toBe("https://acct123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/yg-private/${STORAGE_KEY}`);
  }
}

/* Row per viewer: published, draft, unknown, noSheet, rowMissing, badId. */
const MATRIX: [string | null, string, Expected[]][] = [
  [null, "visitor", ["login", 404, 404, 404, "login", 404]],
  ["active", "active customer", ["file", 404, 404, 404, 404, 404]],
  ["noexpiry", "customer, no expiry", ["file", 404, 404, 404, 404, 404]],
  ["expired", "expired customer", ["renew", 404, 404, 404, "renew", 404]],
  ["banned", "banned customer", ["renew", 404, 404, 404, "renew", 404]],
  ["temp", "temporary password", ["login", 404, 404, 404, "login", 404]],
  ["banended", "ban expired", ["file", 404, 404, 404, 404, 404]],
  ["staff", "other role", ["login", 404, 404, 404, "login", 404]],
  ["admin", "admin", ["file", 404, 404, 404, 404, 404]],
  [
    "tempAdmin",
    "admin, temporary password",
    ["login", 404, 404, 404, "login", 404],
  ],
];
const ORDER: ProductCase[] = [
  "published",
  "draft",
  "unknown",
  "noSheet",
  "rowMissing",
  "badId",
];

describe("GET /api/datasheet/[productId]: access matrix", () => {
  for (const [viewer, label, row] of MATRIX) {
    it.each(ORDER.map((product, i) => [product, row[i] as Expected] as const))(
      `${label} × %s → %s`,
      async (product, expected) => {
        const response = await call(viewer, PRODUCTS[product]);
        expectAnswer(response, expected, product);
        expect(await response.text()).not.toContain(STORAGE_KEY);
      },
    );
  }

  it("accepts an upper-case id like the lower-case one", async () => {
    const response = await call("active", PRODUCTS.published.toUpperCase());
    expectAnswer(response, "file", "published");
  });
});

describe("the presigned URL", () => {
  it("lives 60 s and names an .xlsx attachment (RFC 5987)", async () => {
    const response = await call("noexpiry", PRODUCTS.published);
    const url = new URL(response.headers.get("location") ?? "");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("response-content-type")).toBe(XLSX_MIME_TYPE);
    expect(url.searchParams.get("response-content-disposition")).toBe(
      `attachment; filename="Arc __ datasheet.xlsx"; filename*=UTF-8''Arc%20%E7%B3%BB%E5%88%97%20datasheet.xlsx`,
    );
    expect(await response.text()).toBe("");
  });
});

const logsOf = (name: string) =>
  DownloadLogModel.countDocuments({
    user: new Types.ObjectId(userIds[name]),
  });

describe("the download log", () => {
  it("is written once per successful download, with user, product and file", async () => {
    const before = await logsOf("noexpiry");
    await call("noexpiry", PRODUCTS.published);
    expect(await logsOf("noexpiry")).toBe(before + 1);
    const latest = await DownloadLogModel.findOne(
      { user: new Types.ObjectId(userIds.noexpiry) },
      { _id: 0, product: 1, datasheet: 1 },
    )
      .sort({ downloadedAt: -1 })
      .lean();
    expect(latest).toEqual({
      product: ids.published,
      datasheet: ids.datasheet,
    });
  });

  it("is never written for a refused or failed answer", async () => {
    for (const name of ["expired", "banned", "temp", "staff", "tempAdmin"]) {
      expect(await logsOf(name)).toBe(0);
    }
    // Refusals for an allowed viewer: unknown, draft, no sheet, row missing.
    const before = await logsOf("active");
    for (const product of [
      "draft",
      "unknown",
      "noSheet",
      "rowMissing",
    ] as const)
      await call("active", PRODUCTS[product]);
    expect(await logsOf("active")).toBe(before);
  });

  it("refuses the download (503, no URL) when the log write fails", async () => {
    vi.spyOn(DownloadLogModel, "create").mockRejectedValueOnce(
      new Error(`write failed for ${STORAGE_KEY}`),
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await call("logfail", PRODUCTS.published);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).not.toMatch(/https?:|X-Amz|datasheets\//);
    expect(await logsOf("logfail")).toBe(0);
    // The log line names the error type only: no key, no URL, no message.
    const logged = errors.mock.calls.flat().join(" ");
    expect(logged).toContain("[datasheet]");
    expect(logged).not.toContain(STORAGE_KEY);
    expect(logged).not.toMatch(/https?:|X-Amz/);
  });
});

describe("browser prefetch and HEAD (QA L-1)", () => {
  it.each([
    ["sec-purpose", "prefetch"],
    ["sec-purpose", "prefetch;prerender"],
    ["purpose", "prefetch"],
    ["x-moz", "prefetch"],
    ["x-purpose", "preview"],
  ])(
    "%s: %s is a 204 with nothing read, counted or logged",
    async (name, value) => {
      const before = await logsOf("active");
      request.headers = new Headers({
        cookie: cookies.active ?? "",
        [name]: value,
      });
      const findProduct = vi.spyOn(ProductModel, "findOne");
      const response = await GET(
        new Request(`${AUTH_BASE}/api/datasheet/${PRODUCTS.published}`, {
          headers: { cookie: cookies.active ?? "", [name]: value },
        }),
        { params: Promise.resolve({ productId: PRODUCTS.published }) },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("location")).toBeNull();
      expect(await response.text()).toBe("");
      expect(findProduct).not.toHaveBeenCalled();
      expect(await logsOf("active")).toBe(before);
      findProduct.mockRestore();
    },
  );

  it("a prefetch of a draft or a bad id says nothing either (204 before any lookup)", async () => {
    for (const productId of [PRODUCTS.draft, PRODUCTS.badId]) {
      const response = await GET(
        new Request(`${AUTH_BASE}/api/datasheet/${productId}`, {
          headers: { "sec-purpose": "prefetch" },
        }),
        { params: Promise.resolve({ productId }) },
      );
      expect(response.status).toBe(204);
    }
  });

  it("a header that merely mentions the word is not a prefetch", async () => {
    request.headers = new Headers({ cookie: cookies.active ?? "" });
    const response = await GET(
      new Request(`${AUTH_BASE}/api/datasheet/${PRODUCTS.published}`, {
        headers: { purpose: "noprefetch" },
      }),
      { params: Promise.resolve({ productId: PRODUCTS.published }) },
    );
    expect(response.status).toBe(303);
  });

  it("HEAD is 405, Allow: GET, never cached, and runs nothing", () => {
    const response = HEAD();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("per-user limit (60 per hour)", () => {
  it("allows 60 downloads and answers the 61st with 429", async () => {
    for (let i = 1; i <= 60; i += 1) {
      const response = await call("limited", PRODUCTS.published);
      expect(response.status, `download ${i}`).toBe(303);
    }
    const refused = await call("limited", PRODUCTS.published);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    expect(refused.headers.get("location")).toBeNull();
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(refused.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await refused.text()).toMatch(/^Too many downloads\./);
    expect(
      await DownloadLogModel.countDocuments({
        user: new Types.ObjectId(userIds.limited),
      }),
    ).toBe(60);
  }, 60_000);

  it("never limits the admin", async () => {
    for (let i = 1; i <= 65; i += 1) {
      const response = await call("admin", PRODUCTS.published);
      expect(response.status, `download ${i}`).toBe(303);
    }
    // The admin has no counter at all.
    expect(
      await LoginAttemptModel.countDocuments({
        key: buildKey("download-user", hashUserId(userIds.admin ?? "")),
      }),
    ).toBe(0);
  }, 60_000);

  it("stores no raw user id in the counter key", async () => {
    await call("noexpiry", PRODUCTS.published);
    const keys = await LoginAttemptModel.find(
      { key: /^download-user:/ },
      { _id: 0, key: 1 },
    ).lean();
    expect(keys.length).toBeGreaterThan(0);
    for (const { key } of keys) {
      expect(key).toMatch(/^download-user:[0-9a-f]{64}$/);
      for (const id of Object.values(userIds)) expect(key).not.toContain(id);
    }
  });

  it("fails closed (503) when the limiter is unavailable", async () => {
    vi.spyOn(LoginAttemptModel, "findOneAndUpdate").mockImplementationOnce(
      () => {
        throw new Error("db down");
      },
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await logsOf("active");
    const response = await call("active", PRODUCTS.published);
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(errors.mock.calls.flat().join(" ")).toContain(
      "[datasheet] limiter unavailable: RateLimitUnavailableError",
    );
    expect(await logsOf("active")).toBe(before);
  });

  it("does not count a download whose datasheet record is gone", async () => {
    const key = buildKey("download-user", hashUserId(userIds.logfail ?? ""));
    const before = await LoginAttemptModel.findOne(
      { key },
      { count: 1 },
    ).lean();
    const response = await call("logfail", PRODUCTS.rowMissing);
    expect(response.status).toBe(404);
    const after = await LoginAttemptModel.findOne({ key }, { count: 1 }).lean();
    expect(after?.count ?? 0).toBe(before?.count ?? 0);
  });
});

describe("fail closed on any other failure", () => {
  function expectUnavailable(response: Response): void {
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("retry-after")).toBe("60");
  }

  it("a product lookup failure is a 503, never a 404 or a redirect", async () => {
    vi.spyOn(ProductModel, "findOne").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expectUnavailable(await call("active", PRODUCTS.published));
  });

  it("a session read failure is a 503, never 'signed out'", async () => {
    vi.spyOn(harness.auth.api, "getSession").mockRejectedValueOnce(
      new Error("db down"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expectUnavailable(await call("active", PRODUCTS.published));
  });

  it("a presign failure is a 503 and writes no log", async () => {
    // A stored key outside datasheets/ is refused by presignGet itself.
    vi.spyOn(DatasheetModel, "findById").mockReturnValueOnce({
      lean: async () => ({
        _id: ids.datasheet,
        storageKey: "imports/2f1e6c9a-0b7d-4c55-9a51-7d3e8f0a1b2c.xlsx",
        fileName: FILE_NAME,
      }),
    } as unknown as ReturnType<typeof DatasheetModel.findById>);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await logsOf("active");
    expectUnavailable(await call("active", PRODUCTS.published));
    expect(await logsOf("active")).toBe(before);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("imports/");
  });
});

describe("a ban through Better Auth", () => {
  it("ends the session, so the route sends the customer to sign in", async () => {
    const admin = await signedInAdmin(
      harness,
      "ban-admin@datasheet-route.test",
    );
    await makeCustomer("tobeban");
    expectAnswer(
      await call("tobeban", PRODUCTS.published),
      "file",
      "published",
    );
    await harness.auth.api.banUser({
      body: { userId: userIds.tobeban ?? "", banReason: "test" },
      headers: admin.headers,
    });
    expectAnswer(
      await call("tobeban", PRODUCTS.published),
      "login",
      "published",
    );
  });
});
