// QA (task 5): probes Better Auth 1.7.7's whole HTTP surface through the real
// route handler: no self-registration, no privilege escalation through
// user-facing endpoints, no impersonation, cookie set, log silence on failed
// sign-ins, and alternative paths that must not skip our sign-in gate.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { type Auth, createAuth } from "./auth";
import { handleAuthRequest } from "./auth-handler";
import { getDb } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";
import { DEVICE_COOKIE, verifyDeviceToken } from "./device-token";
import { hashEmail } from "./rate-limit";

const sendReset = vi.hoisted(() => vi.fn());
vi.mock("./email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email")>()),
  sendPasswordResetEmail: sendReset,
}));

const BASE = "http://localhost:3000";
const SESSION_COOKIE = "yg.session_token";
const ADMIN = {
  email: "qa-admin@example.com",
  password: "qa-admin-password-1",
};
const CUSTOMER = {
  email: "qa-customer@example.com",
  password: "qa-customer-password-1",
};

setupMemoryDb("yg_auth_qa_test", { replSet: true });

let auth: Auth;
const background: Promise<unknown>[] = [];
let ipCounter = 1;
/* A fresh documentation-range IP per call, so Better Auth's own per-IP
 * limiter never interferes with what a test is probing. */
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
  auth = createAuth({ runInBackground: (task) => void background.push(task) });
  Object.assign(globalThis, { __ygUniluxAuth: auth });
  await auth.api.createUser({
    body: { ...ADMIN, name: "QA Admin", role: "admin" },
  });
  await auth.api.createUser({ body: { ...CUSTOMER, name: "QA Customer" } });
}, 120_000);

beforeEach(async () => {
  stubEnv();
  sendReset.mockReset();
  sendReset.mockResolvedValue({ id: "email-id" });
  background.length = 0;
  await LoginAttemptModel.deleteMany({});
});

interface CallOptions {
  ip?: string;
  cookie?: string;
  method?: string;
}

function call(
  path: string,
  body: unknown,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: BASE,
    "x-vercel-forwarded-for": options.ip ?? freshIp(),
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  const method = options.method ?? "POST";
  return handleAuthRequest(
    new Request(`${BASE}/api/auth${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body),
    }),
  );
}

function cookieNames(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((line) => line.slice(0, line.indexOf("=")));
}

async function sessionCookie(email: string, password: string) {
  const response = await call("/sign-in/email", { email, password });
  expect(response.status).toBe(200);
  const line =
    response.headers
      .getSetCookie()
      .find((l) => l.startsWith(`${SESSION_COOKIE}=`)) ?? "";
  return line.split(";")[0] ?? "";
}

async function userDoc(email: string) {
  return getDb().collection("users").findOne({ email });
}

describe("no self-registration and no self-escalation over HTTP", () => {
  it("sign-up is refused and creates nothing, even with a role in the body", async () => {
    const response = await call("/sign-up/email", {
      email: "intruder@example.com",
      password: "intruder-password-1",
      name: "Intruder",
      role: "admin",
    });
    // The route is in disabledPaths (404); disableSignUp refuses it too.
    expect(response.status).toBe(404);
    expect(await userDoc("intruder@example.com")).toBeNull();
  });

  it("social sign-in has no providers and creates nothing", async () => {
    const response = await call("/sign-in/social", {
      provider: "google",
      idToken: { token: "x" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await getDb().collection("users").countDocuments()).toBe(2);
  });

  it("a customer can't set role, banned, access or flags through /update-user", async () => {
    const cookie = await sessionCookie(CUSTOMER.email, CUSTOMER.password);
    for (const field of [
      { role: "admin" },
      { banned: true },
      { accessExpiresAt: "2099-01-01T00:00:00.000Z" },
      { mustChangePassword: false },
      { deviceEpoch: 42 },
      { company: "Evil" },
      { email: "other@example.com" },
      { emailVerified: true },
    ]) {
      await call("/update-user", field, { cookie });
    }
    expect(await userDoc(CUSTOMER.email)).toMatchObject({
      role: "customer",
      banned: false,
      mustChangePassword: true,
      deviceEpoch: 0,
    });
    const doc = await userDoc(CUSTOMER.email);
    expect(doc?.accessExpiresAt ?? null).toBeNull();
    expect(doc?.company ?? null).toBeNull();
  });

  it("change-email and delete-user are disabled", async () => {
    const cookie = await sessionCookie(CUSTOMER.email, CUSTOMER.password);
    const change = await call(
      "/change-email",
      { newEmail: "moved@example.com" },
      { cookie },
    );
    expect(change.status).toBe(404);
    const del = await call(
      "/delete-user",
      { password: CUSTOMER.password },
      { cookie },
    );
    expect(del.status).toBe(404);
    expect(await userDoc(CUSTOMER.email)).not.toBeNull();
  });

  it("a customer gets 403 from every admin endpoint that changes data", async () => {
    const cookie = await sessionCookie(CUSTOMER.email, CUSTOMER.password);
    const self = String((await userDoc(CUSTOMER.email))?._id);
    const attempts: [string, unknown][] = [
      [
        "/admin/create-user",
        { email: "x@example.com", password: "x-password-123", name: "X" },
      ],
      ["/admin/set-role", { userId: self, role: "admin" }],
      ["/admin/update-user", { userId: self, data: { role: "admin" } }],
      [
        "/admin/set-user-password",
        { userId: self, newPassword: "x-password-123" },
      ],
      ["/admin/ban-user", { userId: self }],
      // /admin/impersonate-user is in disabledPaths (404); the missing
      // statement is checked through auth.api in "remaining session endpoints".
      ["/admin/remove-user", { userId: self }],
      ["/admin/revoke-user-sessions", { userId: self }],
    ];
    for (const [path, body] of attempts) {
      const response = await call(path, body, { cookie });
      expect(response.status, path).toBe(403);
    }
    const list = await call("/admin/list-users", undefined, {
      cookie,
      method: "GET",
    });
    expect(list.status).toBe(403);
    expect(await userDoc(CUSTOMER.email)).toMatchObject({ role: "customer" });
    expect(await userDoc("x@example.com")).toBeNull();
  });

  it("admin endpoints without any session are 401", async () => {
    const response = await call("/admin/create-user", {
      email: "anon@example.com",
      password: "anon-password-123",
      name: "Anon",
    });
    expect(response.status).toBe(401);
    expect(await userDoc("anon@example.com")).toBeNull();
  });

  it("even the admin can't impersonate (route disabled, statement removed)", async () => {
    const cookie = await sessionCookie(ADMIN.email, ADMIN.password);
    const target = String((await userDoc(CUSTOMER.email))?._id);
    const response = await call(
      "/admin/impersonate-user",
      { userId: target },
      { cookie },
    );
    expect(response.status).toBe(404);
    expect(
      await getDb()
        .collection("sessions")
        .countDocuments({ impersonatedBy: { $exists: true, $ne: null } }),
    ).toBe(0);
  });
});

describe("the sign-in gate can't be side-stepped", () => {
  it("a trailing slash or different case does not reach the sign-in endpoint", async () => {
    for (const path of [
      "/sign-in/email/",
      "/Sign-In/Email",
      "/sign-in//email",
    ]) {
      const response = await call(path, CUSTOMER);
      expect(response.status, path).toBe(404);
      expect(cookieNames(response)).toEqual([]);
    }
  });

  it("a mixed-case email is counted under the same per-email key", async () => {
    const ip = freshIp();
    await call(
      "/sign-in/email",
      { email: CUSTOMER.email.toUpperCase(), password: "wrong-password-1" },
      { ip },
    );
    const digest = hashEmail(CUSTOMER.email);
    expect(
      await LoginAttemptModel.countDocuments({ key: `email-login:${digest}` }),
    ).toBe(1);
  });

  /*
   * Better Auth accepts form-encoded sign-ins (progressive enhancement), so a
   * plain cross-site HTML form is stopped by Fetch Metadata instead: a
   * cross-site navigation is a 403 before any password check, even with the
   * right password (login CSRF).
   */
  it("a cross-site form navigation to sign-in is refused (login CSRF)", async () => {
    const response = await handleAuthRequest(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-vercel-forwarded-for": freshIp(),
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
        body: `email=${encodeURIComponent(CUSTOMER.email)}&password=${encodeURIComponent(CUSTOMER.password)}`,
      }),
    );
    expect(response.status).toBe(403);
    expect(cookieNames(response)).toEqual([]);
  });

  it("a cross-site fetch with Origin is refused before the password check", async () => {
    const response = await handleAuthRequest(
      new Request(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
          "x-vercel-forwarded-for": freshIp(),
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "cors",
        },
        body: JSON.stringify(CUSTOMER),
      }),
    );
    expect(response.status).toBe(403);
    expect(cookieNames(response)).toEqual([]);
  });
});

describe("cookies and logs", () => {
  it("a sign-in sets only the session and device cookies (no cookie cache)", async () => {
    const response = await call("/sign-in/email", CUSTOMER);
    expect(response.status).toBe(200);
    expect(cookieNames(response).sort()).toEqual(
      [DEVICE_COOKIE.name, SESSION_COOKIE].sort(),
    );
    const session =
      response.headers
        .getSetCookie()
        .find((l) => l.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Max-Age=604800/);
  });

  it("rememberMe false adds the dont_remember cookie and a session-only token", async () => {
    const response = await call("/sign-in/email", {
      ...CUSTOMER,
      rememberMe: false,
    });
    expect(response.status).toBe(200);
    expect(cookieNames(response)).toContain("yg.dont_remember");
    const session =
      response.headers
        .getSetCookie()
        .find((l) => l.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(session).not.toMatch(/Max-Age/);
  });

  it("failed sign-ins and resets log nothing that tells accounts apart", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) => vi.spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      await call("/sign-in/email", {
        email: CUSTOMER.email,
        password: "wrong-password-9",
      });
      await call("/sign-in/email", {
        email: "ghost@example.com",
        password: "wrong-password-9",
      });
      await call("/request-password-reset", { email: "ghost@example.com" });
      await Promise.all(background);
      const printed = spies
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map(String).join(" "))
        .join("\n");
      expect(printed).toBe("");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("password oracles behind a session", () => {
  /*
   * QA finding: /verify-password is declared `scope: "server"`, but nothing in
   * better-auth 1.7.7 or better-call reads `scope` (only SERVER_ONLY removes a
   * route), so it is reachable over HTTP. With a stolen session cookie it
   * answers "is this the password?" outside our sign-in gate, limited only by
   * Better Auth's default 100 per minute per network. Fixed: the route is in
   * `disabledPaths` (src/lib/auth.ts DISABLED_PATHS), so it is a 404.
   */
  it("/verify-password is not reachable over HTTP", async () => {
    const cookie = await sessionCookie(CUSTOMER.email, CUSTOMER.password);
    const wrong = await call(
      "/verify-password",
      { password: "not-the-password-1" },
      { cookie },
    );
    const right = await call(
      "/verify-password",
      { password: CUSTOMER.password },
      { cookie },
    );
    expect([wrong.status, right.status]).toEqual([404, 404]);
  });
});

describe("ban through update-user", () => {
  it("revokes sessions and bumps the device epoch", async () => {
    const email = "qa-ban2@example.com";
    const password = "qa-ban2-password-1";
    const created = await auth.api.createUser({
      body: { email, password, name: "Ban Two" },
    });
    const userCookie = await sessionCookie(email, password);
    const admin = await sessionCookie(ADMIN.email, ADMIN.password);
    const response = await call(
      "/admin/update-user",
      { userId: created.user.id, data: { banned: true } },
      { cookie: admin },
    );
    expect(response.status).toBe(200);
    expect(await userDoc(email)).toMatchObject({
      banned: true,
      deviceEpoch: 1,
    });
    const session = await call("/get-session", undefined, {
      cookie: userCookie,
      method: "GET",
    });
    expect(await session.json()).toBeNull();
  });
});

describe("device tokens after an epoch bump", () => {
  it("a sign-in after an admin password change issues a token for the new epoch", async () => {
    const email = "qa-epoch@example.com";
    const created = await auth.api.createUser({
      body: { email, password: "qa-epoch-password-1", name: "Epoch" },
    });
    const admin = await sessionCookie(ADMIN.email, ADMIN.password);
    const changed = await call(
      "/admin/set-user-password",
      { userId: created.user.id, newPassword: "qa-epoch-password-2" },
      { cookie: admin },
    );
    expect(changed.status).toBe(200);
    expect(await userDoc(email)).toMatchObject({ deviceEpoch: 1 });

    const response = await call("/sign-in/email", {
      email,
      password: "qa-epoch-password-2",
    });
    expect(response.status).toBe(200);
    const line =
      response.headers
        .getSetCookie()
        .find((l) => l.startsWith(`${DEVICE_COOKIE.name}=`)) ?? "";
    const token = decodeURIComponent(line.split(";")[0]?.split("=")[1] ?? "");
    expect(verifyDeviceToken(token, email, 1)).not.toBeNull();
    expect(verifyDeviceToken(token, email, 0)).toBeNull();
  });
});

describe("remaining session endpoints (re-review)", () => {
  it("/update-session can't write an IP, user agent or impersonation marker", async () => {
    const cookie = await sessionCookie(CUSTOMER.email, CUSTOMER.password);
    const token = decodeURIComponent(cookie.split("=")[1] ?? "").split(".")[0];
    const response = await call(
      "/update-session",
      {
        ipAddress: "192.0.2.55",
        userAgent: "forged-agent",
        impersonatedBy: "someone",
        userId: "other",
      },
      { cookie },
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    const stored = await getDb().collection("sessions").findOne({ token });
    expect(stored).not.toBeNull();
    expect(stored?.ipAddress ?? "").toBe("");
    expect(stored?.userAgent).not.toBe("forged-agent");
    expect(stored?.impersonatedBy ?? null).toBeNull();
  });

  it("the admin can't impersonate through auth.api either (no statement)", async () => {
    const cookie = await sessionCookie(ADMIN.email, ADMIN.password);
    const target = String((await userDoc(CUSTOMER.email))?._id);
    const result: unknown = await auth.api
      .impersonateUser({
        headers: new Headers({ cookie, origin: BASE }),
        body: { userId: target },
      })
      .catch((e: unknown) => e);
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it("the reset link's GET callback stays open and redirects with the token", async () => {
    await call("/request-password-reset", { email: CUSTOMER.email });
    await Promise.all(background);
    const url = (sendReset.mock.calls.at(-1)?.[0] as { url: string }).url;
    const response = await handleAuthRequest(
      new Request(url.replace("callbackURL=", "callbackURL=%2Freset"), {
        headers: { "x-vercel-forwarded-for": freshIp() },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^http:\/\/localhost:3000\/reset\?token=/,
    );
  });
});
