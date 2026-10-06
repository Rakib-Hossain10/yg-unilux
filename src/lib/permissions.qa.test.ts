// QA (task 6): runs the permission guards against the real Better Auth 1.7.7
// session (in-memory MongoDB), so the user shape the rules rely on (role,
// banned, banExpires, mustChangePassword, accessExpiresAt as Dates) is proven.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { type Auth, createAuth } from "./auth";
import { handleAuthRequest } from "./auth-handler";
import { getDb } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";
import {
  getViewer,
  requireAdmin,
  requireAdminForRoute,
  requireCustomerAccess,
  viewerCanSeeRestricted,
} from "./permissions";

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));

const BASE = "http://localhost:3000";
const SESSION_COOKIE = "yg.session_token";
const ADMIN = {
  email: "perm-admin@example.com",
  password: "perm-admin-pass-1",
};
const CUSTOMER = {
  email: "perm-customer@example.com",
  password: "perm-customer-pass-1",
};

setupMemoryDb("yg_permissions_qa_test", { replSet: true });

let auth: Auth;
let ipCounter = 1;
const freshIp = () => `198.51.100.${ipCounter++ % 250}`;

function stubEnv(): void {
  vi.stubEnv("AUTH_SECRET", "qa-auth-secret-for-better-auth-tests-0123456");
  vi.stubEnv("AUTH_URL", BASE);
  vi.stubEnv("IP_HASH_SECRET", "qa-ip-secret-for-better-auth-tests-9876543");
}

beforeAll(async () => {
  stubEnv();
  await LoginAttemptModel.createIndexes();
  await AuditLogModel.createIndexes();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: () => undefined });
  Object.assign(globalThis, { __ygUniluxAuth: auth });
  await auth.api.createUser({
    body: { ...ADMIN, name: "Perm Admin", role: "admin" },
  });
  await auth.api.createUser({ body: { ...CUSTOMER, name: "Perm Customer" } });
}, 120_000);

beforeEach(async () => {
  stubEnv();
  requestHeaders.current = new Headers();
  await LoginAttemptModel.deleteMany({});
});

async function signIn(email: string, password: string): Promise<Headers> {
  const response = await handleAuthRequest(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-vercel-forwarded-for": freshIp(),
      },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  const line =
    response.headers
      .getSetCookie()
      .find((l) => l.startsWith(`${SESSION_COOKIE}=`)) ?? "";
  return new Headers({ cookie: line.split(";")[0] ?? "" });
}

const setUser = (email: string, fields: Record<string, unknown>) =>
  getDb().collection("users").updateOne({ email }, { $set: fields });

describe("Better Auth session shape seen by the rules", () => {
  it("getViewer's user carries role, ban and our fields, with Date objects", async () => {
    const until = new Date(Date.now() + 86_400_000);
    await setUser(CUSTOMER.email, {
      accessExpiresAt: until,
      banned: false,
      banExpires: null,
    });
    requestHeaders.current = await signIn(CUSTOMER.email, CUSTOMER.password);
    const viewer = await getViewer();
    expect(viewer?.user).toMatchObject({
      role: "customer",
      banned: false,
      mustChangePassword: true,
    });
    expect(viewer?.user.accessExpiresAt).toBeInstanceOf(Date);
    expect((viewer?.user.accessExpiresAt as Date).getTime()).toBe(
      until.getTime(),
    );
  });
});

describe("customer guards with a real session", () => {
  it("a new customer (temporary password) gets no datasheet and no restricted specs", async () => {
    await setUser(CUSTOMER.email, {
      mustChangePassword: true,
      accessExpiresAt: null,
    });
    requestHeaders.current = await signIn(CUSTOMER.email, CUSTOMER.password);
    expect(await requireCustomerAccess()).toEqual({
      ok: false,
      reason: "must-change-password",
    });
    expect(await viewerCanSeeRestricted()).toBe(false);
  });

  it("an expired customer is refused with the expired reason; a current one is allowed", async () => {
    requestHeaders.current = await signIn(CUSTOMER.email, CUSTOMER.password);
    await setUser(CUSTOMER.email, {
      mustChangePassword: false,
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    expect(await requireCustomerAccess()).toEqual({
      ok: false,
      reason: "expired",
    });
    await setUser(CUSTOMER.email, {
      accessExpiresAt: new Date(Date.now() + 60_000),
    });
    expect((await requireCustomerAccess()).ok).toBe(true);
    expect(await viewerCanSeeRestricted()).toBe(true);
  });

  it("a ban written outside banUser (session not revoked) still blocks on the next request", async () => {
    requestHeaders.current = await signIn(CUSTOMER.email, CUSTOMER.password);
    await setUser(CUSTOMER.email, {
      mustChangePassword: false,
      accessExpiresAt: null,
      banned: true,
      banExpires: new Date(Date.now() + 3_600_000),
    });
    expect(await requireCustomerAccess()).toEqual({
      ok: false,
      reason: "banned",
    });
    expect(await viewerCanSeeRestricted()).toBe(false);
    await setUser(CUSTOMER.email, { banned: false, banExpires: null });
  });

  it("a customer can never pass the admin guards", async () => {
    await setUser(CUSTOMER.email, { mustChangePassword: false });
    requestHeaders.current = await signIn(CUSTOMER.email, CUSTOMER.password);
    await expect(requireAdmin()).rejects.toThrow("FORBIDDEN");
    const check = await requireAdminForRoute();
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.response.status).toBe(403);
  });

  it("an expired session in the database counts as signed out", async () => {
    requestHeaders.current = await signIn(CUSTOMER.email, CUSTOMER.password);
    const user = await getDb()
      .collection("users")
      .findOne({ email: CUSTOMER.email });
    await getDb()
      .collection("sessions")
      .updateMany(
        { userId: user?._id },
        { $set: { expiresAt: new Date(Date.now() - 1000) } },
      );
    expect(await requireCustomerAccess()).toEqual({
      ok: false,
      reason: "signed-out",
    });
    await expect(requireAdmin()).rejects.toThrow("REDIRECT /login");
  });

  it("a forged session cookie counts as signed out", async () => {
    requestHeaders.current = new Headers({
      cookie: `${SESSION_COOKIE}=forged.value`,
    });
    expect((await requireAdminForRoute()).ok).toBe(false);
    await expect(requireAdmin()).rejects.toThrow("REDIRECT /login");
  });
});

describe("admin guards with a real session", () => {
  it("an admin created with createUser must change the password first", async () => {
    requestHeaders.current = await signIn(ADMIN.email, ADMIN.password);
    await expect(requireAdmin()).rejects.toThrow("REDIRECT /change-password");
    const check = await requireAdminForRoute();
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.response.status).toBe(403);
    expect(await requireCustomerAccess()).toEqual({
      ok: false,
      reason: "must-change-password",
    });
  });

  it("an active admin passes every guard, even with a past accessExpiresAt", async () => {
    await setUser(ADMIN.email, {
      mustChangePassword: false,
      accessExpiresAt: new Date(Date.now() - 1000),
    });
    requestHeaders.current = await signIn(ADMIN.email, ADMIN.password);
    expect((await requireAdmin()).user.email).toBe(ADMIN.email);
    expect((await requireAdminForRoute()).ok).toBe(true);
    expect((await requireCustomerAccess()).ok).toBe(true);
  });

  it("demoting the admin in the database takes effect on the next request", async () => {
    requestHeaders.current = await signIn(ADMIN.email, ADMIN.password);
    await setUser(ADMIN.email, { role: "customer" });
    await expect(requireAdmin()).rejects.toThrow("FORBIDDEN");
    await setUser(ADMIN.email, { role: "admin" });
  });
});

describe("pure rules: odd stored values", () => {
  const NOW = new Date("2026-10-03T12:00:00Z");
  const base = { id: "u", role: "customer", mustChangePassword: false };

  it("an Invalid Date expiry or ban end fails closed", async () => {
    const { checkDatasheetAccess } = await import("./permissions");
    expect(
      checkDatasheetAccess({ ...base, accessExpiresAt: new Date(NaN) }, NOW),
    ).toEqual({ ok: false, reason: "expired" });
    expect(
      checkDatasheetAccess(
        { ...base, banned: true, banExpires: new Date(NaN) },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "banned" });
  });

  it("an empty-string expiry fails closed", async () => {
    const { checkDatasheetAccess } = await import("./permissions");
    expect(checkDatasheetAccess({ ...base, accessExpiresAt: "" }, NOW)).toEqual(
      { ok: false, reason: "expired" },
    );
  });
});
