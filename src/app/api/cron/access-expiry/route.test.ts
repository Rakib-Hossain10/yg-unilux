// Tests for GET /api/cron/access-expiry (ADR 0072): the Bearer check (no
// header, wrong secret, a different length, a malformed header, a missing
// CRON_SECRET) refuses with 401 before anything runs; an authorised call
// runs the job and answers counts only, never an address; every answer is
// `private, no-store`. The job itself is covered by expiry-reminders.test.ts.

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { acquireLock, buildKey, releaseLock } from "@/lib/rate-limit";
import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import { endOfZonedDayAfter } from "@/lib/time-zone";
import { AuditLogModel, SiteContentModel, UserModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import {
  seedUserFields,
  setupAuthHarness,
} from "../../../../../test/helpers/auth-harness";

import { GET, maxDuration, runtime } from "./route";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const mail = vi.hoisted(() => ({ reminders: 0, digests: 0 }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendExpiryReminderEmail: vi.fn(async () => {
    mail.reminders += 1;
    return { id: "email-id" };
  }),
  sendExpiryDigestEmail: vi.fn(async () => {
    mail.digests += 1;
    return { id: "digest-id" };
  }),
}));

const harness = setupAuthHarness("yg_cron_access_expiry_route_test");

const SECRET = "cron-route-test-secret-0123456789abcdef";
const URL_ = "http://localhost:3000/api/cron/access-expiry";
const CUSTOMER_EMAIL = "due-customer@cron-route.test";

function call(authorization?: string): Promise<Response> {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return GET(new Request(URL_, { headers }));
}

async function expectNoStore(response: Response): Promise<void> {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

beforeEach(async () => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("COMPANY_EMAIL", "office@yg.example");
  mail.reminders = 0;
  mail.digests = 0;
  await Promise.all([
    getDb().collection("users").deleteMany({}),
    AuditLogModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
    SiteContentModel.collection.deleteMany({}),
  ]);
  await SiteContentModel.collection.insertOne({
    key: SETTINGS_KEYS.companyEmail,
    value: "sales@yg.example",
  });
  const { user } = await harness.auth.api.createUser({
    body: {
      email: CUSTOMER_EMAIL,
      password: "cron-route-password-123",
      name: "Due Customer",
      role: "customer",
      data: { mustChangePassword: false },
    },
  });
  await seedUserFields(user.id, {
    company: "Due Company",
    accessExpiresAt: endOfZonedDayAfter(new Date(), 3),
  });
});

describe("GET /api/cron/access-expiry", () => {
  it("is a dynamic Node route with room for the run", () => {
    expect(runtime).toBe("nodejs");
    expect(maxDuration).toBe(300);
  });

  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["the wrong secret, same length", `Bearer ${"x".repeat(SECRET.length)}`],
    ["a shorter secret", "Bearer short"],
    ["a longer secret", `Bearer ${SECRET}extra`],
    ["the secret without Bearer", SECRET],
    ["another scheme", `Basic ${SECRET}`],
    ["lowercase bearer", `bearer ${SECRET}`],
    ["two spaces", `Bearer  ${SECRET}`],
    ["a huge header", `Bearer ${"a".repeat(5000)}`],
  ])("401 with %s, and nothing runs", async (_label, authorization) => {
    const response = await call(authorization);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    await expectNoStore(response);
    expect(mail.reminders).toBe(0);
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("401 for everyone when CRON_SECRET is missing (logged by type only)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("CRON_SECRET", "");
    const response = await call("Bearer ");
    expect(response.status).toBe(401);
    const second = await call(`Bearer ${SECRET}`);
    expect(second.status).toBe(401);
    expect(error.mock.calls.flat().join("\n")).toContain("EnvError");
    expect(mail.reminders).toBe(0);
  });

  it("runs the job with the right secret and answers counts only", async () => {
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(200);
    await expectNoStore(response);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      status: "completed",
      due: 1,
      sent: 1,
      failed: 0,
      markFailed: 0,
      truncated: false,
      digest: "sent",
    });
    expect(text).not.toContain("@");
    expect(text).not.toContain("Due Customer");
    expect(text).not.toContain("Due Company");
    expect(mail).toEqual({ reminders: 1, digests: 1 });
    expect(await AuditLogModel.countDocuments()).toBe(1);

    // Idempotent through the route too.
    const again = await call(`Bearer ${SECRET}`);
    expect(await again.json()).toMatchObject({ due: 0, sent: 0 });
    expect(mail.reminders).toBe(1);
  });

  it("409 while another run holds the lock, and nothing is sent", async () => {
    const key = buildKey(
      "cron-lock",
      createHash("sha256").update("expiry-reminders").digest("hex"),
    );
    const owner = await acquireLock(key, 60);
    try {
      const response = await call(`Bearer ${SECRET}`);
      expect(response.status).toBe(409);
      await expectNoStore(response);
      expect(await response.json()).toEqual({ status: "busy" });
      expect(mail.reminders).toBe(0);
    } finally {
      await releaseLock(key, owner!);
    }
  });

  it("503 with counts when the run stops part-way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(UserModel, "find").mockImplementation(() => {
      throw new Error("MongoServerSelectionError");
    });
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(503);
    await expectNoStore(response);
    expect(await response.json()).toMatchObject({
      status: "aborted",
      due: 1,
      sent: 0,
    });
  });

  it("503 with no detail when the run fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(LoginAttemptModel, "findOneAndUpdate").mockImplementation(() => {
      throw new Error(`boom ${CUSTOMER_EMAIL}`);
    });
    const response = await call(`Bearer ${SECRET}`);
    expect(response.status).toBe(503);
    await expectNoStore(response);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(error.mock.calls.flat().join("\n")).not.toContain("@");
  });
});
