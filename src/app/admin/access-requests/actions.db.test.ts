// The access-request Server Actions against REAL Better Auth sessions on the
// memory replica set (Phase 5 P7): a visitor, a customer and a banned admin
// change nothing in the database (no user, no request status, no audit
// entry, no invite link), and the signed-in admin's approval creates the
// customer with a copy-once link that only the action's answer carries.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { AccessRequestModel, AuditLogModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import {
  AUTH_BASE,
  seedUserFields,
  setupAuthHarness,
  signedInAdmin,
  signIn,
} from "../../../../test/helpers/auth-harness";

import {
  approveAccessRequestAction,
  createManualAccessRequestAction,
  deleteAccessRequestAction,
  newInviteLinkAction,
  rejectAccessRequestAction,
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
    sendAccessDeclinedEmail: vi.fn(count),
  };
});

const harness = setupAuthHarness("yg_admin_access_request_actions_test");

const cookies: Record<string, string> = {};
let adminHeaders: Headers;
let pendingId = "";
let handledId = "";
let existingUserId = "";

function asCookie(cookie: string | null): Headers {
  const headers = new Headers({ origin: AUTH_BASE });
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

async function makeUser(
  name: string,
  role: "admin" | "customer",
): Promise<string> {
  const email = `${name}@queue-actions.test`;
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
  const [users, requests, audit, links] = await Promise.all([
    db
      .collection("users")
      .find({}, { projection: { email: 1, accessExpiresAt: 1, banned: 1 } })
      .sort({ email: 1 })
      .toArray(),
    AccessRequestModel.find({}, { status: 1, email: 1, user: 1 })
      .sort({ email: 1 })
      .lean()
      .exec(),
    AuditLogModel.countDocuments({}).exec(),
    db.collection("verifications").countDocuments({}),
  ]);
  return JSON.stringify({ users, requests, audit, links, mail: mail.sent });
}

beforeAll(async () => {
  const admin = await signedInAdmin(harness, "queue-actions-admin@example.com");
  adminHeaders = admin.headers;
  existingUserId = await makeUser("customer", "customer");
  const bannedId = await makeUser("banned-admin", "admin");
  // A ban that sign-in would refuse is seeded after the session exists.
  await seedUserFields(bannedId, { banned: true });

  const [pendingDoc, handledDoc] = await AccessRequestModel.create([
    {
      name: "Jane Doe",
      email: "jane@queue-actions.test",
      company: "Lights Ltd",
      country: "Hong Kong",
      source: "form",
      status: "pending",
    },
    {
      name: "John Roe",
      email: "john@queue-actions.test",
      source: "whatsapp",
      status: "rejected",
      handledAt: new Date(),
    },
  ]);
  pendingId = pendingDoc!._id.toHexString();
  handledId = handledDoc!._id.toHexString();
}, 120_000);

beforeEach(async () => {
  await LoginAttemptModel.deleteMany({});
});

const CALLS: [string, () => Promise<unknown>][] = [
  [
    "approve",
    () =>
      approveAccessRequestAction({
        requestId: pendingId,
        name: "Jane Doe",
        access: { kind: "none" },
        delivery: "copy",
      }),
  ],
  [
    "reject",
    () => rejectAccessRequestAction({ requestId: pendingId, sendEmail: true }),
  ],
  [
    "manual entry",
    () =>
      createManualAccessRequestAction({
        name: "Mallory",
        email: "mallory@queue-actions.test",
      }),
  ],
  ["delete", () => deleteAccessRequestAction({ requestId: handledId })],
  [
    "new invite link",
    () => newInviteLinkAction({ userId: existingUserId, delivery: "copy" }),
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
  it("approve creates the customer and hands the copy-once link back", async () => {
    request.headers = adminHeaders;
    const result = await approveAccessRequestAction({
      requestId: pendingId,
      name: "Jane Doe",
      company: "Lights Ltd",
      country: "Hong Kong",
      access: { kind: "months", months: 3 },
      delivery: "copy",
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.data.created).toBe(true);
    expect(result.data.invite?.state).toBe("copy");
    expect(
      result.data.invite?.state === "copy" ? result.data.invite.url : "",
    ).toMatch(/\/reset-password\?token=.+&invite=1$/);

    const user = await getDb()
      .collection("users")
      .findOne({ email: "jane@queue-actions.test" });
    expect(user?.role).toBe("customer");
    expect(user?.mustChangePassword).toBe(true);
    const stored = await AccessRequestModel.findById(pendingId).lean().exec();
    expect(stored?.status).toBe("approved");
    // Nothing readable about the link is stored in the audit entry.
    const audit = await AuditLogModel.find({
      action: "access_request.approve",
    })
      .lean()
      .exec();
    expect(JSON.stringify(audit)).not.toMatch(/token|reset-password/);
  });

  it("rejects with the raw form values of an empty reason and no email", async () => {
    request.headers = adminHeaders;
    const doc = await AccessRequestModel.create({
      name: "Empty Reason",
      email: "empty-reason@queue-actions.test",
      source: "form",
      status: "pending",
    });
    // Exactly what the reject dialog sends when Reason is left blank.
    const result = await rejectAccessRequestAction({
      requestId: doc._id.toHexString(),
      reason: "",
      sendEmail: false,
    });
    expect(result).toEqual({ ok: true, data: { emailSent: false } });
    const stored = await AccessRequestModel.findById(doc._id).lean().exec();
    expect(stored?.status).toBe("rejected");
    expect(stored?.rejectReason ?? null).toBeNull();
  });

  it("approves with the raw form values of an empty company and country", async () => {
    request.headers = adminHeaders;
    const doc = await AccessRequestModel.create({
      name: "No Company",
      email: "no-company@queue-actions.test",
      source: "whatsapp",
      status: "pending",
    });
    // Exactly what the approve dialog sends with the optional fields blank.
    const result = await approveAccessRequestAction({
      requestId: doc._id.toHexString(),
      name: "No Company",
      company: "",
      country: "",
      access: { kind: "date", date: "2027-01-31" },
      delivery: "email",
      notifyExtension: true,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.data.accessExpiresAt).toBe("2027-01-31T23:59:59.999Z");
    expect(result.data.invite?.state).toBe("sent");
  });
});
