// The customer Server Actions against REAL Better Auth sessions on the memory
// replica set (Phase 5 P8): a visitor, a customer and a banned admin change
// nothing in the database (no user field, session, link, audit entry or
// email), and the signed-in admin's calls work with the raw form values.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { AuditLogModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import {
  AUTH_BASE,
  linkCount,
  rawUser,
  seedUserFields,
  sessionCount,
  setupAuthHarness,
  signedInAdmin,
  signIn,
} from "../../../../test/helpers/auth-harness";

import {
  banCustomerAction,
  createCustomerAction,
  newCustomerInviteAction,
  revokeCustomerSessionsAction,
  sendCustomerResetLinkAction,
  setCustomerAccessAction,
  setTemporaryPasswordAction,
  unbanCustomerAction,
  updateCustomerProfileAction,
} from "./actions";

const request = vi.hoisted(() => ({ headers: new Headers() }));
const mail = vi.hoisted(() => ({ sent: 0 }));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));
vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const count = async () => {
    mail.sent++;
    return { id: "email-id" };
  };
  return {
    ...(await importOriginal<typeof import("@/lib/email")>()),
    sendInviteEmail: vi.fn(count),
    sendAccessExtendedEmail: vi.fn(count),
    sendPasswordResetEmail: vi.fn(count),
  };
});

const harness = setupAuthHarness("yg_admin_customer_actions_test");

const cookies: Record<string, string> = {};
let adminHeaders: Headers;
let targetId = "";

function asCookie(cookie: string | null): Headers {
  const headers = new Headers({ origin: AUTH_BASE });
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

async function makeUser(
  name: string,
  role: "admin" | "customer",
): Promise<string> {
  const email = `${name}@customer-actions.test`;
  const password = `${name}-password-123456`;
  const { user } = await harness.auth.api.createUser({
    body: {
      email,
      password,
      name,
      role,
      data: { mustChangePassword: false, accessExpiresAt: null },
    },
  });
  cookies[name] = await signIn(email, password);
  return user.id;
}

/* Everything an action could have changed. */
async function snapshot() {
  const db = getDb();
  const [users, sessions, audit, links] = await Promise.all([
    db
      .collection("users")
      .find(
        {},
        {
          projection: {
            email: 1,
            name: 1,
            company: 1,
            country: 1,
            accessExpiresAt: 1,
            banned: 1,
            banReason: 1,
            mustChangePassword: 1,
            invitedAt: 1,
            inviteExpiresAt: 1,
          },
        },
      )
      .sort({ email: 1 })
      .toArray(),
    db.collection("sessions").countDocuments({}),
    AuditLogModel.countDocuments({}).exec(),
    db.collection("verifications").countDocuments({}),
  ]);
  return JSON.stringify({ users, sessions, audit, links, mail: mail.sent });
}

beforeAll(async () => {
  const admin = await signedInAdmin(
    harness,
    "customer-actions-admin@example.com",
  );
  adminHeaders = admin.headers;
  await makeUser("customer", "customer");
  targetId = await makeUser("target", "customer");
  const bannedId = await makeUser("banned-admin", "admin");
  // A ban that sign-in would refuse is seeded after the session exists.
  await seedUserFields(bannedId, { banned: true });
}, 120_000);

beforeEach(async () => {
  await LoginAttemptModel.deleteMany({});
});

const CALLS: [string, () => Promise<unknown>][] = [
  [
    "create",
    () =>
      createCustomerAction({
        name: "Mallory",
        email: "mallory@customer-actions.test",
        access: { kind: "none" },
        delivery: "copy",
      }),
  ],
  [
    "profile",
    () =>
      updateCustomerProfileAction({
        userId: targetId,
        name: "Renamed",
        company: "Evil Ltd",
        country: "",
      }),
  ],
  [
    "access",
    () =>
      setCustomerAccessAction({
        userId: targetId,
        access: { kind: "months", months: 12 },
        notify: true,
      }),
  ],
  ["block", () => banCustomerAction({ userId: targetId, reason: "x" })],
  ["unblock", () => unbanCustomerAction({ userId: targetId })],
  ["end sessions", () => revokeCustomerSessionsAction({ userId: targetId })],
  ["reset link", () => sendCustomerResetLinkAction({ userId: targetId })],
  [
    "temporary password",
    () => setTemporaryPasswordAction({ userId: targetId }),
  ],
  [
    "new invite",
    () => newCustomerInviteAction({ userId: targetId, delivery: "copy" }),
  ],
];

describe.each([
  ["a visitor", () => asCookie(null), "REDIRECT /login"],
  ["a customer", () => asCookie(cookies.customer ?? ""), "FORBIDDEN"],
  [
    "a banned admin",
    () => asCookie(cookies["banned-admin"] ?? ""),
    "FORBIDDEN",
  ],
])("as %s", (_who, headersFor, outcome) => {
  it.each(CALLS)("%s changes nothing in the database", async (_name, call) => {
    request.headers = headersFor();
    const before = await snapshot();
    await expect(call()).rejects.toThrow(outcome);
    expect(await snapshot()).toBe(before);
  });
});

describe("as the signed-in admin", () => {
  it("creates with the raw form values and hands the copy-once link back", async () => {
    request.headers = adminHeaders;
    // Exactly what the form sends with the optional fields blank.
    const result = await createCustomerAction({
      name: "Jane Doe",
      email: "Jane@Customer-Actions.test",
      company: "",
      country: "",
      access: { kind: "date", date: "2027-01-31" },
      delivery: "copy",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.data.invite.state).toBe("copy");
    expect(
      result.data.invite.state === "copy" ? result.data.invite.url : "",
    ).toMatch(/\/reset-password\?token=.+&invite=1$/);
    // The end of 31 Jan 2027 in China time.
    expect(result.data.accessExpiresAt).toBe("2027-01-31T15:59:59.999Z");

    const user = await getDb()
      .collection("users")
      .findOne({ email: "jane@customer-actions.test" });
    expect(user).toMatchObject({
      role: "customer",
      mustChangePassword: true,
      company: null,
    });
    const audit = await AuditLogModel.find({ action: "customer.create" })
      .lean()
      .exec();
    expect(JSON.stringify(audit)).not.toMatch(/token|reset-password|@/);
  });

  it("a temporary password comes back once and is never audited", async () => {
    request.headers = adminHeaders;
    const result = await setTemporaryPasswordAction({ userId: targetId });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.data.password).toHaveLength(16);
    expect((await rawUser(targetId))?.mustChangePassword).toBe(true);
    expect(await linkCount(targetId)).toBe(0);
    const audit = await AuditLogModel.find({}).lean().exec();
    expect(JSON.stringify(audit)).not.toContain(result.data.password);
  });

  it("blocking ends the customer's sessions; unblocking lifts it", async () => {
    request.headers = adminHeaders;
    await signIn("customer@customer-actions.test", "customer-password-123456");
    const customer = await getDb()
      .collection("users")
      .findOne({ email: "customer@customer-actions.test" });
    const id = customer?._id.toHexString() ?? "";
    expect(await sessionCount(id)).toBeGreaterThan(0);

    // A blank reason is refused by the server schema.
    await expect(
      banCustomerAction({ userId: id, reason: "  " }),
    ).resolves.toMatchObject({ ok: false, saved: false });

    await expect(
      banCustomerAction({ userId: id, reason: "Left the company" }),
    ).resolves.toEqual({ ok: true });
    expect(await sessionCount(id)).toBe(0);
    expect((await rawUser(id))?.banned).toBe(true);

    await expect(unbanCustomerAction({ userId: id })).resolves.toEqual({
      ok: true,
    });
    expect((await rawUser(id))?.banned).toBe(false);
  });

  it("the admin account is not a customer: every write refuses it", async () => {
    request.headers = adminHeaders;
    const admin = await getDb()
      .collection("users")
      .findOne({ email: "customer-actions-admin@example.com" });
    const id = admin?._id.toHexString() ?? "";
    for (const result of [
      await banCustomerAction({ userId: id, reason: "nope" }),
      await setTemporaryPasswordAction({ userId: id }),
      await newCustomerInviteAction({ userId: id, delivery: "copy" }),
    ]) {
      expect(result).toMatchObject({ ok: false, saved: false });
    }
  });
});
