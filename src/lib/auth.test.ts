// Integration tests for src/lib/auth.ts + auth-handler.ts: Better Auth 1.7.7 on
// an in-memory MongoDB replica set (its adapter uses transactions, as on Atlas),
// driven through real Request objects and auth.api. Email sending is mocked.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  type Auth,
  DISABLED_PATHS,
  createAuth,
  getSessionFromDb,
  hasRole,
} from "./auth";
import { handleAuthRequest } from "./auth-handler";
import { getDb } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";
import { DEVICE_COOKIE, verifyDeviceToken } from "./device-token";
import { EmailSendError } from "./email";
import { hashEmail } from "./rate-limit";

const sendReset = vi.hoisted(() => vi.fn());
vi.mock("./email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email")>()),
  sendPasswordResetEmail: sendReset,
}));

const BASE = "http://localhost:3000";
const AUTH_SECRET = "test-auth-secret-for-better-auth-tests-0123";
const IP_SECRET = "test-ip-secret-for-better-auth-tests-987654";
const ADMIN = { email: "admin@example.com", password: "admin-password-123" };
const CUSTOMER = {
  email: "customer@example.com",
  password: "customer-password-1",
};
const SESSION_COOKIE = "yg.session_token"; // __Secure-yg.session_token over https

setupMemoryDb("yg_auth_test", { replSet: true });

let auth: Auth;
const background: Promise<unknown>[] = [];

function stubEnv(): void {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("AUTH_URL", BASE);
  vi.stubEnv("IP_HASH_SECRET", IP_SECRET);
}

beforeAll(async () => {
  stubEnv();
  await LoginAttemptModel.createIndexes();
  await AuditLogModel.createIndexes();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: (task) => void background.push(task) });
  // handleAuthRequest() and getSessionFromDb() use getAuth(); give them ours.
  Object.assign(globalThis, { __ygUniluxAuth: auth });
  for (const user of [
    { ...ADMIN, name: "Admin", role: "admin" as const },
    { ...CUSTOMER, name: "Jane Customer" },
  ]) {
    await auth.api.createUser({ body: user });
  }
}, 120_000);

beforeEach(async () => {
  stubEnv();
  sendReset.mockReset();
  sendReset.mockResolvedValue({ id: "email-id" });
  background.length = 0;
  await LoginAttemptModel.deleteMany({});
  await AuditLogModel.deleteMany({});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CallOptions {
  ip?: string;
  cookies?: Record<string, string>;
  origin?: string;
}

/* POSTs JSON to /api/auth<path> through the real route handler. */
function post(
  path: string,
  body: unknown,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: options.origin ?? BASE,
  });
  if (options.ip) headers.set("x-vercel-forwarded-for", options.ip);
  if (options.cookies) {
    headers.set(
      "cookie",
      Object.entries(options.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    );
  }
  return handleAuthRequest(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/* Name -> value of every Set-Cookie on a response. */
function setCookies(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const at = pair.indexOf("=");
    out[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
  }
  return out;
}

function setCookieLine(response: Response, name: string): string {
  return (
    response.headers.getSetCookie().find((l) => l.startsWith(`${name}=`)) ?? ""
  );
}

const signIn = (email: string, password: string, options?: CallOptions) =>
  post("/sign-in/email", { email, password }, options);

async function userDoc(email: string) {
  return getDb().collection("users").findOne({ email });
}

async function signedInHeaders(
  email: string,
  password: string,
  ip: string,
): Promise<Headers> {
  const response = await signIn(email, password, { ip });
  expect(response.status).toBe(200);
  const token = setCookies(response)[SESSION_COOKIE] ?? "";
  return new Headers({
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    origin: BASE,
  });
}

async function resetPasswordTo(email: string, password: string, ip: string) {
  const request = await post("/request-password-reset", { email }, { ip });
  expect(request.status).toBe(200);
  await Promise.all(background);
  const call = sendReset.mock.calls.at(-1)?.[0] as { url: string } | undefined;
  const token = /\/reset-password\/([^?]+)/.exec(call?.url ?? "")?.[1] ?? "";
  return post("/reset-password", { token, newPassword: password }, { ip });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("accounts", () => {
  it("refuses public sign-up over HTTP (404) and through auth.api (disableSignUp)", async () => {
    const body = {
      email: "new@example.com",
      password: "a-long-password-1",
      name: "New",
    };
    const response = await post("/sign-up/email", body, { ip: "203.0.113.10" });
    expect(response.status).toBe(404);
    const direct: unknown = await auth.api
      .signUpEmail({ body })
      .catch((e: unknown) => e);
    expect(direct).toMatchObject({ statusCode: 400 });
    expect(await userDoc("new@example.com")).toBeNull();
  });

  it("admin createUser makes a customer that must change the password, with an argon2id hash", async () => {
    const user = await userDoc(CUSTOMER.email);
    expect(user).toMatchObject({
      role: "customer",
      mustChangePassword: true,
      deviceEpoch: 0,
      banned: false,
    });
    const account = await getDb()
      .collection("accounts")
      .findOne({ userId: user?._id, providerId: "credential" });
    expect(String(account?.password)).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/,
    );
    const adminUser = await userDoc(ADMIN.email);
    expect(hasRole({ role: String(adminUser?.role) }, "admin")).toBe(true);
  });

  it("additional fields can't be set through the public API (input: false)", async () => {
    const headers = await signedInHeaders(
      CUSTOMER.email,
      CUSTOMER.password,
      "203.0.113.11",
    );
    await auth.api
      .updateUser({
        headers,
        body: { mustChangePassword: false, deviceEpoch: 99 } as never,
      })
      .catch((e: unknown) => e);
    expect(await userDoc(CUSTOMER.email)).toMatchObject({
      mustChangePassword: true,
      deviceEpoch: 0,
    });
  });
});

describe("hasRole", () => {
  it("splits comma-joined roles and trims them", () => {
    expect(hasRole({ role: "admin" }, "admin")).toBe(true);
    expect(hasRole({ role: "customer,admin" }, "admin")).toBe(true);
    expect(hasRole({ role: "customer, admin" }, "admin")).toBe(true);
    expect(hasRole({ role: "administrator" }, "admin")).toBe(false);
    expect(hasRole({ role: "customer" }, "admin")).toBe(false);
    expect(hasRole({ role: null }, "customer")).toBe(false);
    expect(hasRole(null, "admin")).toBe(false);
  });
});

describe("sign-in", () => {
  it("works, sets the session and device cookies, and clears only the path used", async () => {
    const ip = "203.0.113.20";
    // One failed attempt first, so there is a network counter to clear.
    expect(
      (await signIn(CUSTOMER.email, "wrong-password-1", { ip })).status,
    ).toBe(401);
    const response = await signIn(CUSTOMER.email, CUSTOMER.password, { ip });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");

    const cookies = setCookies(response);
    expect(cookies[SESSION_COOKIE]).toBeTruthy();
    expect(setCookieLine(response, SESSION_COOKIE)).toMatch(/HttpOnly/);
    const device = setCookieLine(response, DEVICE_COOKIE.name);
    expect(device).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    expect(device).not.toMatch(/Domain=/i);
    expect(
      verifyDeviceToken(cookies[DEVICE_COOKIE.name], CUSTOMER.email, 0),
    ).not.toBeNull();

    const digest = hashEmail(CUSTOMER.email);
    // The network counter is gone, the per-email slow-down stays.
    expect(
      await LoginAttemptModel.countDocuments({
        key: new RegExp(`^email-ip-login:${digest}\\.`),
      }),
    ).toBe(0);
    expect(
      await LoginAttemptModel.countDocuments({ key: `email-login:${digest}` }),
    ).toBe(1);
  });

  it("signs in through the device path with the device cookie and clears only the device counter", async () => {
    const ip = "203.0.113.21";
    const first = await signIn(CUSTOMER.email, CUSTOMER.password, { ip });
    const device = setCookies(first)[DEVICE_COOKIE.name] ?? "";
    const networkBefore = await LoginAttemptModel.countDocuments({
      key: /^email-ip-login:/,
    });
    const second = await signIn(CUSTOMER.email, CUSTOMER.password, {
      ip,
      cookies: { [DEVICE_COOKIE.name]: device },
    });
    expect(second.status).toBe(200);
    expect(
      await LoginAttemptModel.countDocuments({ key: /^email-dev-login:/ }),
    ).toBe(0);
    expect(
      await LoginAttemptModel.countDocuments({ key: /^email-ip-login:/ }),
    ).toBe(networkBefore);
    // A refreshed token is issued.
    expect(setCookies(second)[DEVICE_COOKIE.name]).toBeTruthy();
  });

  it("stores no IP on the session", async () => {
    await signIn(CUSTOMER.email, CUSTOMER.password, { ip: "203.0.113.22" });
    const sessions = await getDb().collection("sessions").find({}).toArray();
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) expect(s.ipAddress ?? "").toBe("");
  });

  it("counts wrong passwords: the 6th from one network is a generic 429 with Retry-After", async () => {
    const ip = "203.0.113.30";
    for (let i = 0; i < 5; i++) {
      expect(
        (await signIn(CUSTOMER.email, `wrong-password-${i}`, { ip })).status,
      ).toBe(401);
    }
    // Even the right password is refused now: the gate runs first.
    const refused = await signIn(CUSTOMER.email, CUSTOMER.password, { ip });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(800);
    expect(await refused.json()).toEqual({
      message: "Too many requests. Please try again later.",
    });
    expect(refused.headers.getSetCookie()).toEqual([]);

    const audit = await AuditLogModel.find({}).lean();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "auth.rate_limited",
      meta: { namespace: "email-ip-login", reason: "hard_limit" },
    });
    expect(audit[0]?.actor).toBeUndefined();
    expect(JSON.stringify(audit)).not.toMatch(/example|203\.0\.113/);
  });

  it("answers unknown and known emails with the same status and body", async () => {
    const known: [number, unknown][] = [];
    const unknown: [number, unknown][] = [];
    for (let i = 0; i < 6; i++) {
      const a = await signIn(CUSTOMER.email, "wrong-password-x", {
        ip: "203.0.113.31",
      });
      known.push([a.status, await a.json()]);
      const b = await signIn("nobody@example.com", "wrong-password-x", {
        ip: "203.0.113.32",
      });
      unknown.push([b.status, await b.json()]);
    }
    expect(unknown).toEqual(known);
    expect(known.map(([s]) => s)).toEqual([401, 401, 401, 401, 401, 429]);
  });

  it("refuses an invalid email with 400 before counting anything", async () => {
    const response = await signIn("not-an-email", "whatever-password");
    expect(response.status).toBe(400);
    expect(await LoginAttemptModel.countDocuments({ key: /^email-/ })).toBe(0);
  });

  it("checks the Origin when cookies are sent (CSRF)", async () => {
    const response = await signIn(CUSTOMER.email, CUSTOMER.password, {
      ip: "203.0.113.33",
      cookies: { other: "1" },
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
  });
});

describe("disabled endpoints (QA M1)", () => {
  it("every disabled path answers 404, even for a signed-in user, and changes nothing", async () => {
    const headers = await signedInHeaders(
      CUSTOMER.email,
      CUSTOMER.password,
      "203.0.113.90",
    );
    const cookie = headers.get("cookie") ?? "";
    const before = await userDoc(CUSTOMER.email);
    for (const path of DISABLED_PATHS) {
      for (const method of ["POST", "GET"]) {
        const response = await handleAuthRequest(
          new Request(`${BASE}/api/auth${path}`, {
            method,
            headers: {
              "content-type": "application/json",
              origin: BASE,
              cookie,
              "x-vercel-forwarded-for": "203.0.113.91",
            },
            body:
              method === "POST"
                ? JSON.stringify({ password: CUSTOMER.password, name: "X" })
                : undefined,
          }),
        );
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(await userDoc(CUSTOMER.email)).toEqual(before);
  });

  it("keeps the endpoints we use: get-session, sign-out and change-password", async () => {
    const headers = await signedInHeaders(
      CUSTOMER.email,
      CUSTOMER.password,
      "203.0.113.92",
    );
    const session = await handleAuthRequest(
      new Request(`${BASE}/api/auth/get-session`, { headers }),
    );
    expect(session.status).toBe(200);
    const out = await handleAuthRequest(
      new Request(`${BASE}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          ...Object.fromEntries(headers),
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(out.status).toBe(200);
  });
});

describe("change-password (QA L2)", () => {
  it("bumps the device epoch, so an old device token fails, and hands this browser a fresh one", async () => {
    const email = "changepw@example.com";
    await auth.api.createUser({
      body: { email, password: "change-old-pw-12", name: "Change Pw" },
    });
    const first = await signIn(email, "change-old-pw-12", {
      ip: "203.0.113.93",
    });
    const oldDevice = setCookies(first)[DEVICE_COOKIE.name] ?? "";
    expect(verifyDeviceToken(oldDevice, email, 0)).not.toBeNull();

    const changed = await post(
      "/change-password",
      {
        currentPassword: "change-old-pw-12",
        newPassword: "change-new-pw-12",
        revokeOtherSessions: true,
      },
      {
        ip: "203.0.113.93",
        cookies: { [SESSION_COOKIE]: setCookies(first)[SESSION_COOKIE] ?? "" },
      },
    );
    expect(changed.status).toBe(200);
    expect(await userDoc(email)).toMatchObject({ deviceEpoch: 1 });
    expect(verifyDeviceToken(oldDevice, email, 1)).toBeNull();
    const fresh = setCookies(changed)[DEVICE_COOKIE.name] ?? "";
    expect(verifyDeviceToken(fresh, email, 1)).not.toBeNull();
  });

  it("a wrong current password changes nothing", async () => {
    const email = "changepw2@example.com";
    await auth.api.createUser({
      body: { email, password: "change-old-pw-34", name: "Change Pw 2" },
    });
    const first = await signIn(email, "change-old-pw-34", {
      ip: "203.0.113.94",
    });
    const changed = await post(
      "/change-password",
      { currentPassword: "not-the-password", newPassword: "change-new-pw-34" },
      {
        ip: "203.0.113.94",
        cookies: { [SESSION_COOKIE]: setCookies(first)[SESSION_COOKIE] ?? "" },
      },
    );
    expect(changed.status).toBe(400);
    expect(await userDoc(email)).toMatchObject({ deviceEpoch: 0 });
  });
});

describe("sessions from the database", () => {
  it("getSessionFromDb returns the user with our fields and no deviceEpoch", async () => {
    const headers = await signedInHeaders(
      CUSTOMER.email,
      CUSTOMER.password,
      "203.0.113.40",
    );
    const session = await getSessionFromDb(headers);
    expect(session?.user).toMatchObject({
      email: CUSTOMER.email,
      role: "customer",
      mustChangePassword: true,
    });
    expect(session?.user).not.toHaveProperty("deviceEpoch");
    expect(await getSessionFromDb(new Headers())).toBeNull();
  });
});

describe("ban", () => {
  it("revokes the banned user's sessions, blocks sign-in and kills device tokens", async () => {
    const email = "banned@example.com";
    const password = "banned-password-1";
    const created = await auth.api.createUser({
      body: { email, password, name: "To Ban" },
    });
    const first = await signIn(email, password, { ip: "203.0.113.50" });
    const device = setCookies(first)[DEVICE_COOKIE.name] ?? "";
    const userCookie = new Headers({
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(setCookies(first)[SESSION_COOKIE] ?? "")}`,
    });
    expect(await getSessionFromDb(userCookie)).not.toBeNull();

    const admin = await signedInHeaders(
      ADMIN.email,
      ADMIN.password,
      "203.0.113.51",
    );
    await auth.api.banUser({
      headers: admin,
      body: { userId: created.user.id },
    });

    expect(await getSessionFromDb(userCookie)).toBeNull();
    expect(await userDoc(email)).toMatchObject({
      banned: true,
      deviceEpoch: 1,
    });
    expect(verifyDeviceToken(device, email, 1)).toBeNull();
    const again = await signIn(email, password, { ip: "203.0.113.52" });
    expect(again.status).toBe(403);
    expect(again.headers.getSetCookie()).toEqual([]);
  });

  it("a customer has no admin permission", async () => {
    const customer = await signedInHeaders(
      CUSTOMER.email,
      CUSTOMER.password,
      "203.0.113.53",
    );
    const admin = await userDoc(ADMIN.email);
    const result: unknown = await auth.api
      .banUser({ headers: customer, body: { userId: String(admin?._id) } })
      .catch((e: unknown) => e);
    expect(result).toMatchObject({ statusCode: 403 });
    expect(await userDoc(ADMIN.email)).toMatchObject({ banned: false });
  });
});

describe("admin password change", () => {
  it("bumps the device epoch and revokes the user's sessions", async () => {
    const email = "setpw@example.com";
    const created = await auth.api.createUser({
      body: { email, password: "first-password-12", name: "Set Pw" },
    });
    const userCookie = await signedInHeaders(
      email,
      "first-password-12",
      "203.0.113.60",
    );
    const admin = await signedInHeaders(
      ADMIN.email,
      ADMIN.password,
      "203.0.113.61",
    );
    await auth.api.setUserPassword({
      headers: admin,
      body: { userId: created.user.id, newPassword: "second-password-12" },
    });
    expect(await userDoc(email)).toMatchObject({ deviceEpoch: 1 });
    expect(await getSessionFromDb(userCookie)).toBeNull();
  });
});

describe("admin password change when the epoch write fails", () => {
  it("has already revoked the sessions and reports the failure instead of succeeding", async () => {
    const email = "failbump@example.com";
    const created = await auth.api.createUser({
      body: { email, password: "first-password-34", name: "Fail Bump" },
    });
    const userCookie = await signedInHeaders(
      email,
      "first-password-34",
      "203.0.113.62",
    );
    const admin = await signedInHeaders(
      ADMIN.email,
      ADMIN.password,
      "203.0.113.63",
    );
    const context = await auth.$context;
    const update = vi
      .spyOn(context.internalAdapter, "updateUser")
      .mockRejectedValueOnce(new Error("Atlas blip"));

    const result: unknown = await auth.api
      .setUserPassword({
        headers: admin,
        body: { userId: created.user.id, newPassword: "second-password-34" },
      })
      .then(() => "resolved")
      .catch((e: unknown) => e);

    expect(update).toHaveBeenCalled();
    expect(result).toBeInstanceOf(Error);
    // The old session is gone even though the epoch bump failed.
    expect(await getSessionFromDb(userCookie)).toBeNull();
  });
});

describe("password reset", () => {
  it("a request goes through the reset limiter and sends the email in the background", async () => {
    const response = await post(
      "/request-password-reset",
      { email: CUSTOMER.email },
      { ip: "203.0.113.70" },
    );
    expect(response.status).toBe(200);
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(sendReset).toHaveBeenCalledTimes(1);
    const [arg] = sendReset.mock.calls[0] as [
      { to: string; name: string; url: string },
    ];
    expect(arg.to).toBe(CUSTOMER.email);
    expect(arg.url).toMatch(
      new RegExp(
        `^${BASE}/api/auth/reset-password/[A-Za-z0-9]+\\?callbackURL=`,
      ),
    );
    const digest = hashEmail(CUSTOMER.email);
    expect(
      await LoginAttemptModel.countDocuments({
        key: new RegExp(`^email-(ip-)?reset:${digest}`),
      }),
    ).toBe(2);
    // The token is stored hashed, never as sent.
    const token = /reset-password\/([^?]+)/.exec(arg.url)?.[1] ?? "";
    const raw = JSON.stringify(
      await getDb().collection("verifications").find({}).toArray(),
    );
    expect(raw).not.toContain(token);
  });

  it("answers unknown emails identically, sends nothing, and refuses the 4th from one network", async () => {
    const answers: [number, unknown][] = [];
    for (const email of [CUSTOMER.email, "nobody@example.com"]) {
      for (let i = 0; i < 4; i++) {
        const r = await post(
          "/request-password-reset",
          { email },
          { ip: email === CUSTOMER.email ? "203.0.113.71" : "203.0.113.72" },
        );
        answers.push([r.status, await r.json()]);
      }
    }
    expect(answers.slice(4)).toEqual(answers.slice(0, 4));
    expect(answers.map(([s]) => s)).toEqual([
      200, 200, 200, 429, 200, 200, 200, 429,
    ]);
    await Promise.all(background);
    expect(sendReset).toHaveBeenCalledTimes(3);
  });

  it("swallows an email-send failure: same response, only reason/status/code logged", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    sendReset.mockRejectedValue(
      new EmailSendError("provider_error", {
        statusCode: 403,
        providerCode: "validation_error",
      }),
    );
    const failed = await post(
      "/request-password-reset",
      { email: CUSTOMER.email },
      { ip: "203.0.113.73" },
    );
    await Promise.all(background);
    const unknown = await post(
      "/request-password-reset",
      { email: "nobody@example.com" },
      { ip: "203.0.113.74" },
    );
    expect(failed.status).toBe(unknown.status);
    expect(await failed.json()).toEqual(await unknown.json());
    const logged = errors.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain(
      "reason=provider_error status=403 code=validation_error",
    );
    expect(logged).not.toMatch(/customer@|reset-password\//);
  });

  it("completing a reset clears the counters, bumps the epoch and issues a new device token", async () => {
    const email = "resetme@example.com";
    await auth.api.createUser({
      body: { email, password: "old-password-123", name: "Reset Me" },
    });
    const ip = "203.0.113.80";
    const first = await signIn(email, "old-password-123", { ip });
    const oldDevice = setCookies(first)[DEVICE_COOKIE.name] ?? "";
    const oldSession = new Headers({
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(setCookies(first)[SESSION_COOKIE] ?? "")}`,
    });
    for (let i = 0; i < 5; i++) await signIn(email, "wrong-password-z", { ip });
    expect((await signIn(email, "old-password-123", { ip })).status).toBe(429);

    const done = await resetPasswordTo(email, "new-password-123", ip);
    expect(done.status).toBe(200);

    expect(await userDoc(email)).toMatchObject({ deviceEpoch: 1 });
    expect(verifyDeviceToken(oldDevice, email, 1)).toBeNull();
    const fresh = setCookies(done)[DEVICE_COOKIE.name] ?? "";
    expect(verifyDeviceToken(fresh, email, 1)).not.toBeNull();
    expect(
      await LoginAttemptModel.countDocuments({
        key: new RegExp(`:${hashEmail(email)}`),
      }),
    ).toBe(0);
    expect(await getSessionFromDb(oldSession)).toBeNull();
    // The owner is back in at once, from the same network.
    expect((await signIn(email, "new-password-123", { ip })).status).toBe(200);
  });

  it("a reset whose token comes in ?token= still bumps the epoch, clears counters and issues a device token", async () => {
    const email = "querytoken@example.com";
    await auth.api.createUser({
      body: { email, password: "old-password-456", name: "Query Token" },
    });
    const ip = "203.0.113.82";
    for (let i = 0; i < 2; i++) await signIn(email, "wrong-password-q", { ip });
    const request = await post("/request-password-reset", { email }, { ip });
    expect(request.status).toBe(200);
    await Promise.all(background);
    const call = sendReset.mock.calls.at(-1)?.[0] as { url: string };
    const token = /\/reset-password\/([^?]+)/.exec(call.url)?.[1] ?? "";
    expect(token).not.toBe("");

    const done = await post(
      `/reset-password?token=${encodeURIComponent(token)}`,
      { newPassword: "new-password-456" },
      { ip },
    );
    expect(done.status).toBe(200);
    expect(await userDoc(email)).toMatchObject({ deviceEpoch: 1 });
    expect(
      verifyDeviceToken(setCookies(done)[DEVICE_COOKIE.name], email, 1),
    ).not.toBeNull();
    expect(
      await LoginAttemptModel.countDocuments({
        key: new RegExp(`:${hashEmail(email)}`),
      }),
    ).toBe(0);
  });

  it("rejects a new password shorter than 12 characters", async () => {
    const response = await resetPasswordTo(
      CUSTOMER.email,
      "short-pw-1",
      "203.0.113.81",
    );
    expect(response.status).toBe(400);
  });
});

describe("stored data", () => {
  it("holds no raw IP anywhere and Better Auth keeps no rateLimits collection", async () => {
    const ip = "198.18.7.77";
    const ipv6 = "2001:db8:abcd:12::77";
    for (const from of [ip, ipv6]) {
      await signIn(CUSTOMER.email, "wrong-password-q", { ip: from });
      await signIn(CUSTOMER.email, CUSTOMER.password, { ip: from });
      await post(
        "/request-password-reset",
        { email: CUSTOMER.email },
        { ip: from },
      );
    }
    await Promise.all(background);
    const names = (await getDb().listCollections().toArray()).map(
      (c) => c.name,
    );
    expect(names).not.toContain("rateLimits");
    expect(names).not.toContain("rateLimit");
    for (const name of names) {
      const text = JSON.stringify(
        await getDb().collection(name).find({}).toArray(),
      );
      expect(text, name).not.toContain("198.18");
      expect(text, name).not.toContain("2001:db8");
      expect(text, name).not.toContain("127.0.0.1");
    }
    const keys = await LoginAttemptModel.find({}, { key: 1 }).lean();
    for (const { key } of keys) {
      expect(key).toMatch(/^[a-z-]+:[0-9a-f]{64}(\.[0-9a-f]{64})?$/);
    }
    expect(keys.some(({ key }) => key.startsWith("ba-limit:"))).toBe(true);
  });
});
