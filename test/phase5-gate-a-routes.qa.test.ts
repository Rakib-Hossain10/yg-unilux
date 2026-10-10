// QA gate A (Phase 5, P4-P5): extra cases for GET /api/datasheet/[productId]
// and GET /api/cron/access-expiry beyond their own tests, with REAL Better
// Auth sessions on the memory replica set.
//
// Datasheet route: an expired session, a session whose user was deleted, an
// invite-pending customer and a customer with an unreadable expiry all fail
// closed; the order of answers never reveals a draft or a missing file to
// a viewer who may not download; a browser prefetch (Sec-Purpose) costs
// nothing (L-1, fixed).
// Cron route: a configured but invalid CRON_SECRET refuses everything, the
// body keys are an exact allowlist, and invite-pending customers are NOT in
// the due set (ADR 0072 amendment).

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

import { GET as cronGET } from "@/app/api/cron/access-expiry/route";
import { GET as datasheetGET } from "@/app/api/datasheet/[productId]/route";
import { XLSX_MIME_TYPE } from "@/lib/constants";
import { getDb } from "@/lib/db";
import { dueFilter } from "@/lib/expiry-reminders";
import {
  AuditLogModel,
  DatasheetModel,
  DownloadLogModel,
  ProductModel,
  UserModel,
} from "@/models";

import {
  AUTH_BASE,
  seedUserFields,
  setupAuthHarness,
  signIn,
} from "./helpers/auth-harness";
import { testPublicId } from "./helpers/public-ids";

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: async () => undefined,
}));
const mail = vi.hoisted(() => ({ reminders: [] as string[] }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendExpiryReminderEmail: vi.fn(async (input: { to: string }) => {
    mail.reminders.push(input.to);
    return { id: "email-id" };
  }),
  sendExpiryDigestEmail: vi.fn(async () => ({ id: "digest-id" })),
}));

const harness = setupAuthHarness("yg_phase5_gate_a_routes_qa");

const DAY = 86_400_000;
const STORAGE_KEY = "datasheets/7a1e6c9a-0b7d-4c55-9a51-7d3e8f0a1b2c.xlsx";
const productId = new Types.ObjectId();
const datasheetId = new Types.ObjectId();
const SLUG = "gate-a-ga-001";

const cookies: Record<string, string> = {};
const userIds: Record<string, string> = {};

async function customer(
  name: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const email = `${name}@gate-a-routes.test`;
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
  if (Object.keys(fields).length > 0) await seedUserFields(user.id, fields);
}

function stubR2(): void {
  vi.stubEnv("R2_ACCOUNT_ID", "acct123");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIATESTKEY");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret-secret-secret");
  vi.stubEnv("R2_BUCKET", "yg-private");
}

beforeAll(async () => {
  stubR2();
  await DatasheetModel.create({
    _id: datasheetId,
    storageKey: STORAGE_KEY,
    fileName: "gate-a.xlsx",
    size: 10,
    mimeType: XLSX_MIME_TYPE,
    uploadedBy: new Types.ObjectId(),
  });
  await ProductModel.create({
    _id: productId,
    mainCategory: new Types.ObjectId(),
    status: "published",
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" }],
    name: "Gate A",
    slug: SLUG,
    variants: [{ modelNo: "GA-001" }],
    datasheetId,
  });
  await customer("active");
  await customer("sessionexpired");
  await customer("deleted");
  await customer("invitepending", {
    mustChangePassword: true,
    invitedAt: new Date(),
    inviteExpiresAt: new Date(Date.now() + 3 * DAY),
  });
  await customer("baddate", { accessExpiresAt: "not a date" });
  await customer("prefetch");
  // The session ran out (Better Auth must not hand it back).
  await getDb()
    .collection("sessions")
    .updateMany(
      { userId: new Types.ObjectId(userIds.sessionexpired) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
  // The account is gone, its session row is left behind.
  await getDb()
    .collection("users")
    .deleteOne({ _id: new Types.ObjectId(userIds.deleted) });
}, 120_000);

beforeEach(() => {
  stubR2();
  mail.reminders.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function download(
  viewer: string | null,
  extra: Record<string, string> = {},
): Promise<Response> {
  request.headers = new Headers({
    ...(viewer === null ? {} : { cookie: cookies[viewer] ?? "" }),
    ...extra,
  });
  const id = productId.toHexString();
  return datasheetGET(
    new Request(`${AUTH_BASE}/api/datasheet/${id}`, { headers: extra }),
    { params: Promise.resolve({ productId: id }) },
  );
}

const loginLocation = `/login?next=${encodeURIComponent(`/product/${SLUG}`)}`;

describe("datasheet route: sessions and states that must fail closed", () => {
  it.each([
    ["an expired session", "sessionexpired", loginLocation],
    ["a deleted user's leftover session", "deleted", loginLocation],
    [
      "an invite-pending customer (mustChangePassword)",
      "invitepending",
      `/change-password?next=${encodeURIComponent(`/product/${SLUG}`)}`,
    ],
    [
      "an unreadable accessExpiresAt",
      "baddate",
      `/request-access?renew=1&product=${productId.toHexString()}`,
    ],
  ])("%s → 303 without a file, no log", async (_label, viewer, location) => {
    const before = await DownloadLogModel.countDocuments();
    const response = await download(viewer);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(location);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await DownloadLogModel.countDocuments()).toBe(before);
  });

  it("a forged/garbled session cookie is just 'signed out'", async () => {
    request.headers = new Headers({
      cookie: "yg.session_token=forged.value; better-auth.session_token=x",
    });
    const id = productId.toHexString();
    const response = await datasheetGET(
      new Request(`${AUTH_BASE}/api/datasheet/${id}`),
      { params: Promise.resolve({ productId: id }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(loginLocation);
  });

  it("an active customer's answer carries the URL only in Location, never in the body", async () => {
    const response = await download("active");
    expect(response.status).toBe(303);
    expect(await response.text()).toBe("");
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("X-Amz-Expires")).toBe("60");
  });
});

describe("datasheet route: browser prefetch", () => {
  // L-1 (fixed): a speculative request (Chrome/Edge send `Sec-Purpose:
  // prefetch`, older ones `Purpose: prefetch`) used to be answered like a
  // click: a download slot, a presigned URL and a downloadLogs row the
  // customer never asked for.
  it("a Sec-Purpose: prefetch request writes no log and hands out no URL", async () => {
    const before = await DownloadLogModel.countDocuments({
      user: new Types.ObjectId(userIds.prefetch),
    });
    const response = await download("prefetch", {
      "sec-purpose": "prefetch",
    });
    expect(response.headers.get("location") ?? "").not.toContain(
      "r2.cloudflarestorage.com",
    );
    expect(
      await DownloadLogModel.countDocuments({
        user: new Types.ObjectId(userIds.prefetch),
      }),
    ).toBe(before);
  });
});

describe("cron route: secret configuration and body", () => {
  const SECRET = "gate-a-cron-secret-0123456789abcdefXYZ";
  const call = (authorization: string) =>
    cronGET(
      new Request("http://localhost:3000/api/cron/access-expiry", {
        headers: { authorization },
      }),
    );

  it.each([
    ["too short", "short-secret"],
    ["with a space", "gate a cron secret 0123456789abcdefXYZ"],
    ["non-ASCII", "gate-a-cron-secret-0123456789abcdefééé"],
  ])(
    "a configured but invalid CRON_SECRET (%s) refuses even its own value",
    async (_label, secret) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.stubEnv("CRON_SECRET", secret);
      const auditBefore = await AuditLogModel.countDocuments();
      const response = await call(`Bearer ${secret}`);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
      expect(await AuditLogModel.countDocuments()).toBe(auditBefore);
      // Logged by type only: never the value.
      const logged = error.mock.calls.flat().join("\n");
      expect(logged).not.toContain(secret);
    },
  );

  // Leading/trailing whitespace is stripped by the Fetch Headers API itself
  // (header value normalisation), so only inner variations are checked.
  it("a header carrying the secret twice, or with inner extras, is refused", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const header of [
      `Bearer ${SECRET}, Bearer ${SECRET}`,
      `Bearer ${SECRET},`,
      `Bearer\t${SECRET}`,
      `Bearer ${SECRET.slice(0, -1)}`,
    ]) {
      const response = await call(header);
      expect(response.status, JSON.stringify(header)).toBe(401);
    }
  });

  it("the authorised body is an exact allowlist of counts", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("COMPANY_EMAIL", "office@yg.example");
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "digest",
        "due",
        "failed",
        "markFailed",
        "sent",
        "status",
        "truncated",
      ].sort(),
    );
    for (const [key, value] of Object.entries(body)) {
      expect(["number", "boolean", "string"], key).toContain(typeof value);
      if (typeof value === "string") expect(value).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("cron: who is due (ADR 0072 amendment)", () => {
  it("an invite-pending customer whose access ends within 7 days is NOT due", async () => {
    const now = new Date();
    await seedUserFields(userIds.invitepending ?? "", {
      accessExpiresAt: new Date(now.getTime() + 2 * DAY),
    });
    const due = await UserModel.find(dueFilter(now), { _id: 1 }).lean();
    expect(due.map((d) => String(d._id))).not.toContain(userIds.invitepending);
  });
});
