// Phase 5 P1 account flows through the real /api/auth handler and real
// Better Auth on the memory DB: a temporary password changed, invite links
// (72 h, single use, regenerated), forgot-password, and how each one clears
// mustChangePassword, stamps passwordSetAt and kills the other links.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { type Auth, createAuth } from "./auth";
import { handleAuthRequest } from "./auth-handler";
import { getDb, mongoose } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";
import { DEVICE_COOKIE, verifyDeviceToken } from "./device-token";
import {
  createInviteLink,
  InviteError,
  type InviteFields,
  inviteStatus,
} from "./invite";

const sentResets = vi.hoisted(() => [] as string[]);
vi.mock("./email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email")>()),
  sendPasswordResetEmail: vi.fn(async ({ url }: { url: string }) => {
    sentResets.push(url);
    return { id: "email-id" };
  }),
}));

const BASE = "http://localhost:3000";
const HOUR = 3_600_000;

setupMemoryDb("yg_account_flows_test", { replSet: true });

let auth: Auth;
const background: Promise<unknown>[] = [];
let ipCounter = 1;
const freshIp = () => `203.0.113.${ipCounter++ % 250}`;
let userCounter = 0;

function stubEnv(): void {
  vi.stubEnv("AUTH_SECRET", "account-flows-test-secret-0123456789abcdef");
  vi.stubEnv("AUTH_URL", BASE);
  vi.stubEnv("IP_HASH_SECRET", "account-flows-ip-secret-0123456789abcdef");
}

beforeAll(async () => {
  stubEnv();
  await LoginAttemptModel.createIndexes();
  await AuditLogModel.createIndexes();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: (task) => void background.push(task) });
  Object.assign(globalThis, { __ygUniluxAuth: auth });
}, 120_000);

beforeEach(async () => {
  stubEnv();
  sentResets.length = 0;
  background.length = 0;
  await LoginAttemptModel.deleteMany({});
});

function call(path: string, body: unknown, cookie?: string) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: BASE,
    "x-vercel-forwarded-for": freshIp(),
  });
  if (cookie) headers.set("cookie", cookie);
  return handleAuthRequest(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter((pair) => pair.startsWith("yg."))
    .join("; ");
}

function cookieValue(response: Response, name: string): string | undefined {
  const line = response.headers
    .getSetCookie()
    .find((l) => l.startsWith(`${name}=`));
  return line
    ? decodeURIComponent(line.slice(name.length + 1).split(";")[0] ?? "")
    : undefined;
}

/** A fresh customer on a temporary password (as createUser makes them). */
async function newCustomer() {
  userCounter += 1;
  const email = `flow-${userCounter}@example.com`;
  const password = `flow-temp-password-${userCounter}`;
  const { user } = await auth.api.createUser({
    body: { email, password, name: `Flow ${userCounter}` },
  });
  return { id: user.id, email, password };
}

/* The raw users document (InviteFields typed, the rest loose). */
const userDoc = (id: string) =>
  getDb()
    .collection<InviteFields & Record<string, unknown>>("users")
    .findOne({ _id: new mongoose.Types.ObjectId(id) });

async function signIn(email: string, password: string, rememberMe = true) {
  return call("/sign-in/email", { email, password, rememberMe });
}

async function sessionCount(id: string): Promise<number> {
  return getDb()
    .collection("sessions")
    .countDocuments({ userId: new mongoose.Types.ObjectId(id) });
}

function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get("token");
  expect(token).toBeTruthy();
  return token ?? "";
}

async function resetWith(token: string, newPassword: string) {
  return call("/reset-password", { token, newPassword });
}

const INVALID_TOKEN = { code: "INVALID_TOKEN", message: "Invalid token" };

describe("temporary password → /change-password", () => {
  it("clears the flag, stamps passwordSetAt, revokes other sessions and bumps the epoch", async () => {
    const customer = await newCustomer();
    expect(await userDoc(customer.id)).toMatchObject({
      mustChangePassword: true,
    });
    const other = await signIn(customer.email, customer.password);
    const current = await signIn(customer.email, customer.password);
    expect(other.status).toBe(200);
    expect(await sessionCount(customer.id)).toBe(2);
    const epochBefore = Number((await userDoc(customer.id))?.deviceEpoch ?? 0);

    const before = Date.now();
    const changed = await call(
      "/change-password",
      {
        currentPassword: customer.password,
        newPassword: "flow-new-password-1",
        revokeOtherSessions: true,
      },
      cookieHeader(current),
    );
    expect(changed.status).toBe(200);

    const doc = await userDoc(customer.id);
    expect(doc?.mustChangePassword).toBe(false);
    expect((doc?.passwordSetAt as Date).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(doc?.deviceEpoch).toBe(epochBefore + 1);
    // Only the replacement session is left.
    expect(await sessionCount(customer.id)).toBe(1);
    // This browser gets a device token for the NEW epoch.
    const device = cookieValue(changed, DEVICE_COOKIE.name) ?? "";
    expect(
      verifyDeviceToken(device, customer.email, epochBefore + 1),
    ).not.toBeNull();
    // The session list from Better Auth never shows our new fields.
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookieHeader(changed) }),
    });
    expect(session?.user.mustChangePassword).toBe(false);
    expect(session?.user).not.toHaveProperty("passwordSetAt");
    expect(session?.user).not.toHaveProperty("invitedAt");
  });

  it("a wrong current password changes nothing", async () => {
    const customer = await newCustomer();
    const current = await signIn(customer.email, customer.password);
    const response = await call(
      "/change-password",
      {
        currentPassword: "wrong-password-123",
        newPassword: "flow-new-password-1",
        revokeOtherSessions: true,
      },
      cookieHeader(current),
    );
    expect(response.status).toBe(400);
    const doc = await userDoc(customer.id);
    expect(doc?.mustChangePassword).toBe(true);
    expect(doc?.passwordSetAt).toBeUndefined();
  });

  it("kills an outstanding invite link", async () => {
    const customer = await newCustomer();
    const invite = await createInviteLink(customer.id);
    const current = await signIn(customer.email, customer.password);
    const changed = await call(
      "/change-password",
      {
        currentPassword: customer.password,
        newPassword: "flow-new-password-1",
        revokeOtherSessions: true,
      },
      cookieHeader(current),
    );
    expect(changed.status).toBe(200);
    const late = await resetWith(tokenOf(invite.url), "flow-other-password-1");
    expect(late.status).toBe(400);
  });
});

describe("invite links", () => {
  it("are same-origin /reset-password?token=…&invite=1 links valid 72 h", async () => {
    const customer = await newCustomer();
    const before = Date.now();
    const invite = await createInviteLink(customer.id);
    const url = new URL(invite.url);
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe("/reset-password");
    expect(url.searchParams.get("invite")).toBe("1");
    expect(tokenOf(invite.url)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = invite.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(72 * HOUR - 1000);
    expect(ttl).toBeLessThanOrEqual(72 * HOUR + 1000);

    const doc = await userDoc(customer.id);
    expect(doc?.inviteExpiresAt).toEqual(invite.expiresAt);
    expect(inviteStatus(doc ?? {}, new Date())).toEqual({
      state: "pending",
      until: invite.expiresAt,
    });
    // The token is stored hashed: the raw token is nowhere in the database.
    const rows = await getDb().collection("verifications").find({}).toArray();
    expect(JSON.stringify(rows)).not.toContain(tokenOf(invite.url));
  });

  it("set the password, clear the flag and make the status accepted", async () => {
    const customer = await newCustomer();
    const invite = await createInviteLink(customer.id);
    const response = await resetWith(
      tokenOf(invite.url),
      "flow-chosen-password-1",
    );
    expect(response.status).toBe(200);
    const doc = await userDoc(customer.id);
    expect(doc?.mustChangePassword).toBe(false);
    expect(doc?.passwordSetAt).toBeInstanceOf(Date);
    expect(inviteStatus(doc ?? {}, new Date())).toEqual({ state: "accepted" });
    expect(
      (await signIn(customer.email, "flow-chosen-password-1")).status,
    ).toBe(200);
    expect((await signIn(customer.email, customer.password)).status).toBe(401);
  });

  it("work only once", async () => {
    const customer = await newCustomer();
    const token = tokenOf((await createInviteLink(customer.id)).url);
    expect((await resetWith(token, "flow-chosen-password-1")).status).toBe(200);
    const again = await resetWith(token, "flow-chosen-password-2");
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject(INVALID_TOKEN);
  });

  it("still work at 71 h 59 m", async () => {
    const customer = await newCustomer();
    const invite = await createInviteLink(customer.id, {
      now: new Date(Date.now() - (72 * HOUR - 60_000)),
    });
    expect(
      (await resetWith(tokenOf(invite.url), "flow-chosen-password-1")).status,
    ).toBe(200);
  });

  it("expire at 72 h with the same answer as a used link", async () => {
    const customer = await newCustomer();
    const invite = await createInviteLink(customer.id, {
      now: new Date(Date.now() - 72 * HOUR),
    });
    const response = await resetWith(
      tokenOf(invite.url),
      "flow-chosen-password-1",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject(INVALID_TOKEN);
    const doc = await userDoc(customer.id);
    expect(doc?.mustChangePassword).toBe(true);
    expect(inviteStatus(doc ?? {}, new Date())).toMatchObject({
      state: "expired",
    });
  });

  it("a regenerated link kills every earlier one and keeps accessExpiresAt", async () => {
    const customer = await newCustomer();
    const access = new Date("2027-04-30T23:59:59.999Z");
    const context = await auth.$context;
    const { updateAccountFields } = await import("./account-writes");
    await updateAccountFields(context, customer.id, {
      accessExpiresAt: access,
    });
    // Back to back, no delay: rows can share a millisecond and must still
    // be revoked (deleted by id, not by time).
    const first = await createInviteLink(customer.id);
    const second = await createInviteLink(customer.id);
    const third = await createInviteLink(customer.id);

    for (const old of [first, second]) {
      const response = await resetWith(tokenOf(old.url), "flow-chosen-pw-1");
      expect(response.status).toBe(400);
    }
    expect(
      inviteStatus((await userDoc(customer.id)) ?? {}, new Date()),
    ).toEqual({ state: "pending", until: third.expiresAt });
    expect(
      (await resetWith(tokenOf(third.url), "flow-chosen-password-1")).status,
    ).toBe(200);
    expect((await userDoc(customer.id))?.accessExpiresAt).toEqual(access);
  });

  it("a new invite kills a pending forgot-password link", async () => {
    const customer = await newCustomer();
    await call("/request-password-reset", { email: customer.email });
    await Promise.all(background);
    expect(sentResets).toHaveLength(1);
    const resetToken = new URL(sentResets[0] ?? "").pathname.split("/").pop();
    await createInviteLink(customer.id);
    const response = await resetWith(resetToken ?? "", "flow-chosen-pw-12");
    expect(response.status).toBe(400);
  });

  it("refuse an unknown user, an admin, a user with no role and a malformed id", async () => {
    const roleless = await newCustomer();
    await getDb()
      .collection("users")
      .updateOne(
        { _id: new mongoose.Types.ObjectId(roleless.id) },
        { $set: { role: null } },
      );
    await expect(createInviteLink(roleless.id)).rejects.toMatchObject({
      reason: "not_a_customer",
    });
    await expect(
      createInviteLink(new mongoose.Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ reason: "user_not_found" });
    const { user: admin } = await auth.api.createUser({
      body: {
        email: "flow-admin@example.com",
        password: "flow-admin-password-1",
        name: "Flow Admin",
        role: "admin",
      },
    });
    const error = await createInviteLink(admin.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteError);
    expect(error).toMatchObject({ reason: "not_a_customer" });
    await expect(createInviteLink("nope")).rejects.toMatchObject({
      reason: "invalid_input",
    });
  });

  it("never print the link or the token", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      const customer = await newCustomer();
      const invite = await createInviteLink(customer.id);
      await resetWith(tokenOf(invite.url), "flow-chosen-password-1");
      await resetWith(tokenOf(invite.url), "flow-chosen-password-2");
      const printed = JSON.stringify(spies.map((spy) => spy.mock.calls));
      expect(printed).not.toContain(tokenOf(invite.url));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("forgot-password", () => {
  it("still works, clears the flag and kills an outstanding invite", async () => {
    const customer = await newCustomer();
    const invite = await createInviteLink(customer.id);
    const requested = await call("/request-password-reset", {
      email: customer.email,
    });
    expect(requested.status).toBe(200);
    await Promise.all(background);
    expect(sentResets).toHaveLength(1);
    const token = new URL(sentResets[0] ?? "").pathname.split("/").pop() ?? "";

    const before = Date.now();
    expect((await resetWith(token, "flow-forgot-password-1")).status).toBe(200);
    const doc = await userDoc(customer.id);
    expect(doc?.mustChangePassword).toBe(false);
    expect((doc?.passwordSetAt as Date).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(inviteStatus(doc ?? {}, new Date())).toEqual({ state: "accepted" });
    // The invite sent earlier no longer works.
    expect(
      (await resetWith(tokenOf(invite.url), "flow-forgot-password-2")).status,
    ).toBe(400);
  });
});
