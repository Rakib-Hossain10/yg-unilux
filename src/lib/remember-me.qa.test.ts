// QA (Phase 1 wrap-up, ADR 0030/0032): "Keep me signed in" off gives a
// session the server caps at 24 hours and never refreshes, for every role;
// session tokens never appear in /api/auth JSON bodies (real handler).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { type Auth, createAuth } from "./auth";
import { handleAuthRequest } from "./auth-handler";
import { getDb } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";

const BASE = "http://localhost:3000";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ADMIN = {
  email: "rm-admin@example.com",
  password: "rm-admin-password-1",
};
const CUSTOMER = {
  email: "rm-customer@example.com",
  password: "rm-customer-password-1",
};

setupMemoryDb("yg_remember_me_qa_test", { replSet: true });

let auth: Auth;
let ipCounter = 1;
/* A fresh documentation-range IP per call, so Better Auth's per-IP limiter
 * never interferes. */
const freshIp = () => `192.0.2.${ipCounter++ % 250}`;

function stubEnv(): void {
  vi.stubEnv("AUTH_SECRET", "qa-auth-secret-for-remember-me-tests-0123456");
  vi.stubEnv("AUTH_URL", BASE);
  vi.stubEnv("IP_HASH_SECRET", "qa-ip-secret-for-remember-me-tests-9876543");
}

beforeAll(async () => {
  stubEnv();
  await LoginAttemptModel.createIndexes();
  await AuditLogModel.createIndexes();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: () => undefined });
  Object.assign(globalThis, { __ygUniluxAuth: auth });
  await auth.api.createUser({
    body: { ...ADMIN, name: "RM Admin", role: "admin" },
  });
  await auth.api.createUser({ body: { ...CUSTOMER, name: "RM Customer" } });
}, 120_000);

beforeEach(async () => {
  stubEnv();
  await LoginAttemptModel.deleteMany({});
});

function call(
  path: string,
  body: unknown,
  cookie?: string,
  method = "POST",
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
    origin: BASE,
    "x-vercel-forwarded-for": freshIp(),
  });
  if (cookie) headers.set("cookie", cookie);
  return handleAuthRequest(
    new Request(`${BASE}/api/auth${path}`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body),
    }),
  );
}

/* "name=value; name=value" of the auth cookies a response set. */
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter((pair) => pair.startsWith("yg."))
    .join("; ");
}

function tokenOf(cookie: string): string {
  const pair = cookie
    .split("; ")
    .find((p) => p.startsWith("yg.session_token="));
  return decodeURIComponent(pair?.split("=")[1] ?? "").split(".")[0] ?? "";
}

async function storedExpiry(token: string): Promise<number> {
  const doc = await getDb().collection("sessions").findOne({ token });
  expect(doc, "session not stored").not.toBeNull();
  return new Date(doc?.expiresAt as Date).getTime();
}

async function signIn(user: typeof CUSTOMER, rememberMe: boolean) {
  const response = await call("/sign-in/email", { ...user, rememberMe });
  expect(response.status).toBe(200);
  return response;
}

describe("keep me signed in: off (same for admin and customer)", () => {
  for (const [role, user] of [
    ["admin", ADMIN],
    ["customer", CUSTOMER],
  ] as const) {
    it(`${role}: the stored session ends within 24 hours`, async () => {
      const cookie = cookieHeader(await signIn(user, false));
      expect(cookie).toContain("yg.dont_remember=");
      const left = (await storedExpiry(tokenOf(cookie))) - Date.now();
      expect(left).toBeGreaterThan(23 * HOUR);
      expect(left).toBeLessThanOrEqual(DAY);
    });
  }

  it("is never refreshed, even when a remembered session would be", async () => {
    const cookie = cookieHeader(await signIn(CUSTOMER, false));
    const token = tokenOf(cookie);
    const soon = new Date(Date.now() + HOUR);
    await getDb()
      .collection("sessions")
      .updateOne({ token }, { $set: { expiresAt: soon } });
    const response = await call("/get-session", undefined, cookie, "GET");
    expect(response.status).toBe(200);
    expect(await response.json()).not.toBeNull();
    expect(await storedExpiry(token)).toBe(soon.getTime());
    expect(cookieHeader(response)).not.toContain("yg.session_token=");
  });

  it("control: a remembered session in the same state IS refreshed to 7 days", async () => {
    const cookie = cookieHeader(await signIn(CUSTOMER, true));
    const token = tokenOf(cookie);
    await getDb()
      .collection("sessions")
      .updateOne(
        { token },
        { $set: { expiresAt: new Date(Date.now() + HOUR) } },
      );
    const response = await call("/get-session", undefined, cookie, "GET");
    expect(response.status).toBe(200);
    expect((await storedExpiry(token)) - Date.now()).toBeGreaterThan(6 * DAY);
  });

  /*
   * GAP (QA finding L1): Better Auth's /change-password with
   * revokeOtherSessions: true calls createSession(userId) without the
   * dont-remember flag (dist/api/routes/update-user.mjs:176), so the new
   * session is stored for 7 days while the cookie stays session-only and
   * is never refreshed. ADR 0032's "24 h hard cap" does not hold after a
   * password change. `it.fails` turns red once the cap is enforced; then
   * make it a plain `it`.
   */
  it.fails(
    "keeps the 24-hour cap after a change-password with revokeOtherSessions",
    async () => {
      const user = {
        email: "rm-change@example.com",
        password: "rm-change-password-1",
      };
      await auth.api.createUser({ body: { ...user, name: "RM Change" } });
      const cookie = cookieHeader(await signIn(user, false));
      const response = await call(
        "/change-password",
        {
          currentPassword: user.password,
          newPassword: "rm-change-password-2",
          revokeOtherSessions: true,
        },
        cookie,
      );
      expect(response.status).toBe(200);
      const left =
        (await storedExpiry(tokenOf(cookieHeader(response)))) - Date.now();
      expect(left).toBeLessThanOrEqual(DAY);
    },
  );
});

describe("no session token in any /api/auth JSON body (real handler)", () => {
  it("sign-in, get-session, list-sessions and change-password carry no token", async () => {
    const user = {
      email: "rm-token@example.com",
      password: "rm-token-password-1",
    };
    await auth.api.createUser({ body: { ...user, name: "RM Token" } });
    const signedIn = await signIn(user, true);
    const cookie = cookieHeader(signedIn);
    const token = tokenOf(cookie);
    expect(token.length).toBeGreaterThan(10);
    expect(await signedIn.text()).not.toContain(token);
    expect(signedIn.headers.get("cache-control")).toBe("private, no-store");

    const session = await call("/get-session", undefined, cookie, "GET");
    const sessionText = await session.text();
    expect(sessionText).toContain(user.email);
    expect(sessionText).not.toContain(token);
    expect(sessionText).not.toMatch(/"token"/);

    const list = await call("/list-sessions", undefined, cookie, "GET");
    expect(list.status).toBe(200);
    expect(await list.text()).not.toMatch(/"token"/);

    const changed = await call(
      "/change-password",
      {
        currentPassword: user.password,
        newPassword: "rm-token-password-2",
        revokeOtherSessions: true,
      },
      cookie,
    );
    expect(changed.status).toBe(200);
    const newToken = tokenOf(cookieHeader(changed));
    expect(newToken.length).toBeGreaterThan(10);
    expect(await changed.text()).not.toContain(newToken);
  });
});
