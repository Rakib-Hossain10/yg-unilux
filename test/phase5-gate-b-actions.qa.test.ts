// QA gate B (Phase 5, P7 + P8): the admin access-request and customer
// pages and Server Actions, with REAL Better Auth sessions on the memory
// replica set.
//
// 1. Guard sweep, beyond the builders' tests (visitor / customer / banned
//    admin): an admin still on a TEMPORARY password is sent to change it by
//    every action (15) and every page (6, incl. the dashboard), and nothing
//    changes (users, sessions, links, requests, audit, mail). The pages are
//    also refused for the three other callers.
// 2. Unknown, malformed and operator-shaped ids from the signed-in admin:
//    pages 404 (never 500), actions refuse with a form message, nothing
//    changes; the admin's own id is not a customer.
// 3. One-time secrets: the temporary password and copy-once invite links
//    are never in a log line, an audit entry or the users document; an
//    emailed invite returns no link to the browser (inviteView drops it).

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

import {
  approveAccessRequestAction,
  createManualAccessRequestAction,
  deleteAccessRequestAction,
  newInviteLinkAction,
  rejectAccessRequestAction,
} from "@/app/admin/access-requests/actions";
import AccessRequestPage from "@/app/admin/access-requests/[id]/page";
import AdminAccessRequestsPage from "@/app/admin/access-requests/(list)/page";
import { inviteView } from "@/app/admin/action-helpers";
import {
  banCustomerAction,
  createCustomerAction,
  endAccessAction,
  newCustomerInviteAction,
  revokeCustomerSessionsAction,
  sendCustomerResetLinkAction,
  setCustomerAccessAction,
  setTemporaryPasswordAction,
  unbanCustomerAction,
  updateCustomerProfileAction,
} from "@/app/admin/customers/actions";
import CustomerPage from "@/app/admin/customers/[id]/page";
import AdminCustomersPage from "@/app/admin/customers/(list)/page";
import NewCustomerPage from "@/app/admin/customers/new/page";
import AdminDashboardPage from "@/app/admin/(dashboard)/page";
import { getDb } from "@/lib/db";
import { AccessRequestModel, AuditLogModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";

import {
  AUTH_BASE,
  rawUser,
  seedUserFields,
  setupAuthHarness,
  signedInAdmin,
  signIn,
} from "./helpers/auth-harness";

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
  notFound: () => {
    throw new Error("NOT_FOUND");
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
    sendAccessDeclinedEmail: vi.fn(count),
  };
});

const harness = setupAuthHarness("yg_phase5_gate_b_actions");

const cookies: Record<string, string> = {};
let adminHeaders: Headers;
let adminId = "";
let targetId = "";
let pendingId = "";
let handledId = "";

function asCookie(cookie: string | null): Headers {
  const headers = new Headers({ origin: AUTH_BASE });
  if (cookie) headers.set("cookie", cookie);
  return headers;
}

async function makeUser(
  name: string,
  role: "admin" | "customer",
  mustChangePassword = false,
): Promise<string> {
  const email = `${name}@gate-b-actions.test`;
  const password = `${name}-password-123456`;
  const { user } = await harness.auth.api.createUser({
    body: {
      email,
      password,
      name,
      role,
      data: { mustChangePassword, accessExpiresAt: null },
    },
  });
  cookies[name] = await signIn(email, password);
  return user.id;
}

/* Everything an action could have changed. */
async function snapshot() {
  const db = getDb();
  const [users, sessions, requests, audit, links] = await Promise.all([
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
    AccessRequestModel.find({}, { status: 1, email: 1, user: 1, name: 1 })
      .sort({ email: 1 })
      .lean()
      .exec(),
    AuditLogModel.countDocuments({}).exec(),
    db.collection("verifications").countDocuments({}),
  ]);
  return JSON.stringify({
    users,
    sessions,
    requests,
    audit,
    links,
    mail: mail.sent,
  });
}

beforeAll(async () => {
  const admin = await signedInAdmin(
    harness,
    "gate-b-actions-admin@example.com",
  );
  adminHeaders = admin.headers;
  adminId = admin.id;
  await makeUser("customer", "customer");
  targetId = await makeUser("target", "customer");
  const bannedId = await makeUser("banned-admin", "admin");
  await seedUserFields(bannedId, { banned: true });
  // An admin still on a temporary password (signed in, not yet changed).
  await makeUser("temp-admin", "admin", true);

  const [pendingDoc, handledDoc] = await AccessRequestModel.create([
    {
      name: "Jane Doe",
      email: "jane@gate-b-actions.test",
      company: "Lights Ltd",
      country: "Hong Kong",
      source: "form",
      status: "pending",
    },
    {
      name: "John Roe",
      email: "john@gate-b-actions.test",
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

const ACTIONS: [string, () => Promise<unknown>][] = [
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
        email: "mallory@gate-b-actions.test",
      }),
  ],
  ["delete request", () => deleteAccessRequestAction({ requestId: handledId })],
  [
    "request: new invite",
    () => newInviteLinkAction({ userId: targetId, delivery: "copy" }),
  ],
  [
    "create customer",
    () =>
      createCustomerAction({
        name: "Mallory",
        email: "mallory2@gate-b-actions.test",
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
        company: "",
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
  ["end access", () => endAccessAction({ userId: targetId })],
  ["block", () => banCustomerAction({ userId: targetId, reason: "x" })],
  ["unblock", () => unbanCustomerAction({ userId: targetId })],
  ["end sessions", () => revokeCustomerSessionsAction({ userId: targetId })],
  ["reset link", () => sendCustomerResetLinkAction({ userId: targetId })],
  [
    "temporary password",
    () => setTemporaryPasswordAction({ userId: targetId }),
  ],
  [
    "customer: new invite",
    () => newCustomerInviteAction({ userId: targetId, delivery: "copy" }),
  ],
];

const noQuery = () => Promise.resolve({});
const PAGES: [string, () => Promise<unknown>][] = [
  ["dashboard", () => AdminDashboardPage()],
  [
    "requests list",
    () => AdminAccessRequestsPage({ searchParams: noQuery() } as never),
  ],
  [
    "request detail",
    () =>
      AccessRequestPage({
        params: Promise.resolve({ id: pendingId }),
        searchParams: noQuery(),
      } as never),
  ],
  [
    "customers list",
    () => AdminCustomersPage({ searchParams: noQuery() } as never),
  ],
  ["new customer", () => NewCustomerPage()],
  [
    "customer detail",
    () =>
      CustomerPage({
        params: Promise.resolve({ id: targetId }),
        searchParams: noQuery(),
      } as never),
  ],
];

describe("an admin on a temporary password is sent to change it", () => {
  it.each(ACTIONS)(
    "action %s: redirect, nothing changes",
    async (_name, call) => {
      request.headers = asCookie(cookies["temp-admin"] ?? "");
      const before = await snapshot();
      await expect(call()).rejects.toThrow("REDIRECT /change-password");
      expect(await snapshot()).toBe(before);
    },
  );

  it.each(PAGES)("page %s: redirect", async (_name, render) => {
    request.headers = asCookie(cookies["temp-admin"] ?? "");
    await expect(render()).rejects.toThrow("REDIRECT /change-password");
  });
});

describe.each([
  ["a visitor", () => asCookie(null), "REDIRECT /login"],
  ["a customer", () => asCookie(cookies.customer ?? ""), "FORBIDDEN"],
  [
    "a banned admin",
    () => asCookie(cookies["banned-admin"] ?? ""),
    "FORBIDDEN",
  ],
])("pages as %s", (_who, headersFor, outcome) => {
  it.each(PAGES)("%s is refused", async (_name, render) => {
    request.headers = headersFor();
    await expect(render()).rejects.toThrow(outcome);
  });
});

describe("the signed-in admin with unknown, malformed or operator-shaped ids", () => {
  const BAD_IDS: unknown[] = [
    new Types.ObjectId().toHexString(),
    "not-an-id",
    "",
    { $ne: null },
    { $gt: "" },
    ["0123456789abcdef01234567"],
  ];

  it.each([
    ["unknown", new Types.ObjectId().toHexString()],
    ["malformed", "not-an-id"],
    ["too long", "a".repeat(5000)],
  ])("pages answer 404 for a %s id", async (_kind, id) => {
    request.headers = adminHeaders;
    await expect(
      AccessRequestPage({
        params: Promise.resolve({ id }),
        searchParams: noQuery(),
      } as never),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      CustomerPage({
        params: Promise.resolve({ id }),
        searchParams: noQuery(),
      } as never),
    ).rejects.toThrow("NOT_FOUND");
  });

  it("the admin's own id is not a customer page (404)", async () => {
    request.headers = adminHeaders;
    await expect(
      CustomerPage({
        params: Promise.resolve({ id: adminId }),
        searchParams: noQuery(),
      } as never),
    ).rejects.toThrow("NOT_FOUND");
  });

  it.each(BAD_IDS.map((id) => [JSON.stringify(id), id] as const))(
    "id %s: every action refuses and changes nothing",
    async (_label, id) => {
      request.headers = adminHeaders;
      const before = await snapshot();
      const results = [
        await approveAccessRequestAction({
          requestId: id,
          name: "X",
          access: { kind: "none" },
          delivery: "copy",
        }),
        await rejectAccessRequestAction({ requestId: id }),
        await deleteAccessRequestAction({ requestId: id }),
        await newInviteLinkAction({ userId: id, delivery: "copy" }),
        await updateCustomerProfileAction({
          userId: id,
          name: "X",
          company: "",
          country: "",
        }),
        await setCustomerAccessAction({
          userId: id,
          access: { kind: "none" },
          notify: false,
        }),
        await endAccessAction({ userId: id }),
        await banCustomerAction({ userId: id, reason: "x" }),
        await unbanCustomerAction({ userId: id }),
        await revokeCustomerSessionsAction({ userId: id }),
        await sendCustomerResetLinkAction({ userId: id }),
        await setTemporaryPasswordAction({ userId: id }),
        await newCustomerInviteAction({ userId: id, delivery: "copy" }),
      ];
      for (const result of results) {
        expect(result).toMatchObject({ ok: false, saved: false });
      }
      expect(await snapshot()).toBe(before);
    },
  );
});

describe("one-time secrets never reach a log, the audit trail or the users document", () => {
  const lines: string[] = [];
  beforeEach(() => {
    lines.length = 0;
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(
          args
            .map((a) =>
              a instanceof Error
                ? `${a.name} ${a.message} ${a.stack}`
                : String(a),
            )
            .join(" "),
        );
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function everythingStored(): Promise<string> {
    const db = getDb();
    const [audit, users] = await Promise.all([
      AuditLogModel.find({}).lean().exec(),
      db.collection("users").find({}).toArray(),
    ]);
    return JSON.stringify({ audit, users });
  }

  it("temporary password, copy-once links from create / approve / new invite", async () => {
    request.headers = adminHeaders;
    const secrets: string[] = [];
    const tokenOf = (url: string) =>
      new URL(url).searchParams.get("token") ?? "";

    const temp = await setTemporaryPasswordAction({ userId: targetId });
    if (!temp.ok) throw new Error(JSON.stringify(temp.errors));
    secrets.push(temp.data.password);

    const created = await createCustomerAction({
      name: "Secret Keeper",
      email: "secret-keeper@gate-b-actions.test",
      company: "",
      country: "",
      access: { kind: "months", months: 3 },
      delivery: "copy",
    });
    if (!created.ok || created.data.invite.state !== "copy")
      throw new Error("no copy link");
    secrets.push(tokenOf(created.data.invite.url));

    const again = await newCustomerInviteAction({
      userId: created.data.userId,
      delivery: "copy",
    });
    if (!again.ok || again.data.invite.state !== "copy")
      throw new Error("no copy link");
    secrets.push(tokenOf(again.data.invite.url));

    const approved = await approveAccessRequestAction({
      requestId: pendingId,
      name: "Jane Doe",
      company: "",
      country: "",
      access: { kind: "months", months: 6 },
      delivery: "copy",
      notifyExtension: false,
    });
    if (!approved.ok || approved.data.invite?.state !== "copy") {
      throw new Error(`approve: ${JSON.stringify(approved)}`);
    }
    secrets.push(tokenOf(approved.data.invite.url));

    // Emailed: the browser never receives a link.
    const emailed = await newCustomerInviteAction({
      userId: created.data.userId,
      delivery: "email",
    });
    if (!emailed.ok) throw new Error(JSON.stringify(emailed.errors));
    expect(JSON.stringify(emailed)).not.toMatch(/token|reset-password|https?:/);

    for (const secret of secrets) expect(secret.length).toBeGreaterThan(10);
    const stored = await everythingStored();
    const logs = lines.join("\n");
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    // No email address or name in any log line either.
    expect(logs).not.toMatch(/@gate-b-actions\.test|Secret Keeper|Jane Doe/);
    // The temporary password is stored only as an argon2id hash.
    const account = await getDb()
      .collection("accounts")
      .findOne({
        userId: new Types.ObjectId(targetId),
        providerId: "credential",
      });
    expect(String(account?.password ?? "")).toMatch(/^\$argon2id\$/);
    expect((await rawUser(targetId))?.mustChangePassword).toBe(true);
  });

  it("inviteView keeps a url only for the copy state", () => {
    const expiresAt = new Date("2026-10-13T08:00:00Z");
    const stray = {
      url: "https://x.example/reset-password?token=SECRET&invite=1",
      expiresAt,
    };
    for (const state of ["sent", "send_failed"] as const) {
      const view = inviteView({ state, ...stray } as never);
      expect(JSON.stringify(view)).not.toContain("SECRET");
    }
    expect(
      JSON.stringify(inviteView({ state: "busy", ...stray } as never)),
    ).not.toContain("SECRET");
    expect(inviteView({ state: "copy", ...stray } as never)).toMatchObject({
      state: "copy",
      url: stray.url,
    });
  });
});
