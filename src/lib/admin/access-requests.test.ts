// Tests for the access-request queue services (src/lib/admin/
// access-requests.ts, ADR 0069) with REAL Better Auth on the memory replica
// set: approve creates a customer (role, flag, expiry, invite), an existing
// email is extended (never a second account; an expired invite re-sent),
// double approval is refused, the admin's email is refused, partial
// failures never extend twice or skip an invite on retry, reject, manual
// entry, delete handled only, the list, and audit meta without emails.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import { AccessRequestModel, AuditLogModel, UserModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import {
  authCall,
  linkCount,
  rawUser,
  seedUserFields,
  setupAuthHarness,
  signedInAdmin,
} from "../../../test/helpers/auth-harness";

import {
  approveAccessRequest,
  createManualAccessRequest,
  deleteAccessRequest,
  getAccessRequest,
  listAccessRequests,
  rejectAccessRequest,
} from "./access-requests";
import type { AdminActor } from "./customers";
import type { ServiceResult } from "./write-result";

const mail = vi.hoisted(() => ({
  invites: [] as { to: string; url: string }[],
  extended: [] as string[],
  declined: [] as string[],
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendInviteEmail: vi.fn(async (input: { to: string; url: string }) => {
    mail.invites.push({ to: input.to, url: input.url });
    return { id: "email-id" };
  }),
  sendAccessExtendedEmail: vi.fn(async (input: { to: string }) => {
    mail.extended.push(input.to);
    return { id: "email-id" };
  }),
  sendAccessDeclinedEmail: vi.fn(async (input: { to: string }) => {
    mail.declined.push(input.to);
    return { id: "email-id" };
  }),
}));

const harness = setupAuthHarness("yg_admin_access_requests_test");
let admin: AdminActor;
const ADMIN_EMAIL = "queue-admin@example.com";
const now = new Date("2026-10-09T12:00:00.000Z");
let counter = 0;

beforeAll(async () => {
  admin = await signedInAdmin(harness, ADMIN_EMAIL);
}, 120_000);

beforeEach(async () => {
  mail.invites.length = 0;
  mail.extended.length = 0;
  mail.declined.length = 0;
  vi.restoreAllMocks();
  await LoginAttemptModel.deleteMany({});
});

function expectOk<T>(result: ServiceResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected ok: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

function formErrors<T>(result: ServiceResult<T>): string[] {
  if (result.ok) throw new Error("expected a failure");
  return result.errors.formErrors;
}

const nextEmail = () => `requester-${++counter}@example.com`;

async function pending(email = nextEmail(), fields: object = {}) {
  const doc = await AccessRequestModel.create({
    name: "Jane Doe",
    email,
    company: "Acme Lighting",
    country: "Hong Kong",
    source: "form",
    consentAt: now,
    ...fields,
  });
  return { id: doc._id.toHexString(), email };
}

const approveInput = (requestId: string, extra: object = {}) => ({
  requestId,
  name: "Jane Doe",
  company: "Acme Lighting",
  country: "Hong Kong",
  access: { kind: "months", months: 6 },
  ...extra,
});

const usersWith = (email: string) =>
  getDb().collection("users").countDocuments({ email });

describe("approveAccessRequest: new email", () => {
  it("creates a customer (role, flag, expiry), invites and links the request", async () => {
    const request = await pending();
    const data = expectOk(
      await approveAccessRequest(admin, approveInput(request.id), { now }),
    );
    expect(data).toMatchObject({
      created: true,
      notified: false,
      blocked: false,
      invite: { state: "sent" },
    });
    expect(data.accessExpiresAt?.toISOString()).toBe(
      "2027-04-09T23:59:59.999Z",
    );
    expect(await rawUser(data.userId)).toMatchObject({
      email: request.email,
      role: "customer",
      mustChangePassword: true,
      accessExpiresAt: new Date("2027-04-09T23:59:59.999Z"),
      company: "Acme Lighting",
    });
    expect(mail.invites.map((m) => m.to)).toEqual([request.email]);
    const stored = await AccessRequestModel.findById(request.id).lean();
    expect(stored?.status).toBe("approved");
    expect(stored?.user?.toHexString()).toBe(data.userId);
    expect(stored?.handledBy?.toHexString()).toBe(admin.id);
  });

  it("copy delivery returns the link once instead of emailing it", async () => {
    const request = await pending();
    const data = expectOk(
      await approveAccessRequest(
        admin,
        approveInput(request.id, { delivery: "copy" }),
        { now },
      ),
    );
    expect(data.invite).toMatchObject({
      state: "copy",
      url: expect.stringContaining("invite=1"),
    });
    expect(mail.invites).toHaveLength(0);
  });

  it("a second approval of the same request is refused", async () => {
    const request = await pending();
    expectOk(await approveAccessRequest(admin, approveInput(request.id)));
    expect(
      formErrors(await approveAccessRequest(admin, approveInput(request.id))),
    ).toEqual(["This request has already been handled."]);
    expect(await usersWith(request.email)).toBe(1);
  });

  it("two approvals at once: exactly one wins", async () => {
    const request = await pending();
    const results = await Promise.all([
      approveAccessRequest(admin, approveInput(request.id)),
      approveAccessRequest(admin, approveInput(request.id)),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await usersWith(request.email)).toBe(1);
  });
});

describe("approveAccessRequest: existing email", () => {
  it("extends from the current end, never a second account; a pending invite is not re-sent", async () => {
    const first = await pending();
    const created = expectOk(
      await approveAccessRequest(admin, approveInput(first.id), { now }),
    );
    mail.invites.length = 0;

    const second = await pending(first.email, { kind: "renewal" });
    const data = expectOk(
      await approveAccessRequest(
        admin,
        approveInput(second.id, { access: { kind: "months", months: 3 } }),
        { now },
      ),
    );
    expect(data).toMatchObject({
      created: false,
      userId: created.userId,
      invite: null,
      notified: true,
    });
    // 2027-04-09 + 3 months, end of day UTC.
    expect(data.accessExpiresAt?.toISOString()).toBe(
      "2027-07-09T23:59:59.999Z",
    );
    expect(await usersWith(first.email)).toBe(1);
    expect(mail.invites).toHaveLength(0);
    expect(mail.extended).toEqual([first.email]);
  });

  it("an expired invite is re-sent (never a second account)", async () => {
    const first = await pending();
    const created = expectOk(
      await approveAccessRequest(admin, approveInput(first.id), { now }),
    );
    // The 72 h link ran out without a password being set.
    await seedUserFields(created.userId, {
      inviteExpiresAt: new Date(now.getTime() - 1),
    });
    mail.invites.length = 0;
    const second = await pending(first.email);
    const data = expectOk(
      await approveAccessRequest(admin, approveInput(second.id), { now }),
    );
    expect(data.created).toBe(false);
    expect(data.invite?.state).toBe("sent");
    expect(mail.invites.map((m) => m.to)).toEqual([first.email]);
    expect(await usersWith(first.email)).toBe(1);
  });

  it("a blocked customer whose invite expired gets no new link (like regenerateInvite)", async () => {
    const first = await pending();
    const created = expectOk(
      await approveAccessRequest(admin, approveInput(first.id), { now }),
    );
    await seedUserFields(created.userId, {
      inviteExpiresAt: new Date(now.getTime() - 1),
      banned: true,
      banExpires: null,
    });
    const linksBefore = await linkCount(created.userId);
    mail.invites.length = 0;
    const second = await pending(first.email);
    const data = expectOk(
      await approveAccessRequest(admin, approveInput(second.id), { now }),
    );
    expect(data).toMatchObject({
      created: false,
      blocked: true,
      invite: null,
      inviteWithheld: true,
    });
    expect(mail.invites).toHaveLength(0);
    expect(await linkCount(created.userId)).toBe(linksBefore);
    // Access is still extended: approving neither unblocks nor skips that.
    expect(data.accessExpiresAt).not.toBeNull();
    const audit = await AuditLogModel.findOne({
      action: "access_request.approve",
      "target.id": second.id,
    }).lean();
    expect(audit?.meta).toMatchObject({ invite: "withheld" });
  });

  it("a blocked customer is no reason to withhold when no invite is due", async () => {
    const first = await pending();
    const created = expectOk(
      await approveAccessRequest(admin, approveInput(first.id), { now }),
    );
    await seedUserFields(created.userId, { banned: true, banExpires: null });
    const second = await pending(first.email);
    const data = expectOk(
      await approveAccessRequest(admin, approveInput(second.id), { now }),
    );
    expect(data).toMatchObject({ invite: null, inviteWithheld: false });
  });

  it("a customer who set a password gets no invite", async () => {
    const first = await pending();
    expectOk(await approveAccessRequest(admin, approveInput(first.id)));
    const token = new URL(mail.invites[0]?.url ?? "").searchParams.get("token");
    const reset = await authCall("/reset-password", {
      token,
      newPassword: "requester-own-password-1",
    });
    expect(reset.status).toBe(200);
    mail.invites.length = 0;
    const second = await pending(first.email);
    const data = expectOk(
      await approveAccessRequest(admin, approveInput(second.id)),
    );
    expect(data.invite).toBeNull();
  });

  it("the admin's own email is refused and the request goes back to pending", async () => {
    const request = await pending(ADMIN_EMAIL);
    expect(
      formErrors(
        await approveAccessRequest(admin, approveInput(request.id)),
      )[0],
    ).toMatch(/admin account/);
    expect((await AccessRequestModel.findById(request.id).lean())?.status).toBe(
      "pending",
    );
    expect((await rawUser(admin.id))?.accessExpiresAt).toBeUndefined();
  });
});

describe("approveAccessRequest: partial failures and retries", () => {
  it("a failure before any account write puts the request back; the retry works", async () => {
    const request = await pending();
    const spy = vi.spyOn(UserModel, "findOne").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    expect(
      formErrors(await approveAccessRequest(admin, approveInput(request.id))),
    ).toEqual(["Something went wrong. Please try again."]);
    spy.mockRestore();
    expect((await AccessRequestModel.findById(request.id).lean())?.status).toBe(
      "pending",
    );
    expect(await usersWith(request.email)).toBe(0);
    expectOk(await approveAccessRequest(admin, approveInput(request.id)));
    expect(await usersWith(request.email)).toBe(1);
  });

  it("an invite failure after the account was created keeps the approval; a later approval sends the invite and extends once", async () => {
    const request = await pending();
    // The invite limiter's database fails (only the invite step uses it here).
    const spy = vi
      .spyOn(LoginAttemptModel, "findOneAndUpdate")
      .mockImplementation(() => {
        throw new Error("db down");
      });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const data = expectOk(
      await approveAccessRequest(admin, approveInput(request.id), { now }),
    );
    spy.mockRestore();
    expect(data.created).toBe(true);
    expect(data.invite).toEqual({ state: "failed" });
    expect((await AccessRequestModel.findById(request.id).lean())?.status).toBe(
      "approved",
    );
    expect((await rawUser(data.userId))?.invitedAt).toBeUndefined();

    // A new request from the same email: no second account, the missing
    // invite is sent now, and access is extended from the stored end.
    const again = await pending(request.email);
    const second = expectOk(
      await approveAccessRequest(
        admin,
        approveInput(again.id, {
          access: { kind: "months", months: 3 },
          notifyExtension: false,
        }),
        { now },
      ),
    );
    expect(second.created).toBe(false);
    expect(second.invite?.state).toBe("sent");
    expect(second.accessExpiresAt?.toISOString()).toBe(
      "2027-07-09T23:59:59.999Z",
    );
    expect(await usersWith(request.email)).toBe(1);
  });

  it("a failed access write on an existing customer changes nothing and releases the claim", async () => {
    const first = await pending();
    const created = expectOk(
      await approveAccessRequest(admin, approveInput(first.id), { now }),
    );
    const before = (await rawUser(created.userId))?.accessExpiresAt;
    const second = await pending(first.email);
    const context = await harness.auth.$context;
    vi.spyOn(context.internalAdapter, "updateUser").mockRejectedValueOnce(
      new Error("db down"),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await approveAccessRequest(admin, approveInput(second.id), { now })).ok,
    ).toBe(false);
    expect((await rawUser(created.userId))?.accessExpiresAt).toEqual(before);
    expect((await AccessRequestModel.findById(second.id).lean())?.status).toBe(
      "pending",
    );
  });
});

describe("reject / manual / delete", () => {
  it("rejects with an internal reason and no email by default", async () => {
    const request = await pending();
    const data = expectOk(
      await rejectAccessRequest(admin, {
        requestId: request.id,
        reason: "Competitor",
      }),
    );
    expect(data.emailSent).toBe(false);
    expect(mail.declined).toHaveLength(0);
    const stored = await AccessRequestModel.findById(request.id).lean();
    expect(stored).toMatchObject({
      status: "rejected",
      rejectReason: "Competitor",
    });
    const audit = await AuditLogModel.findOne({
      action: "access_request.reject",
      "target.id": request.id,
    }).lean();
    expect(JSON.stringify(audit)).not.toContain("Competitor");
  });

  it("sends the polite decline only when asked, without the reason", async () => {
    const request = await pending();
    const data = expectOk(
      await rejectAccessRequest(admin, {
        requestId: request.id,
        sendEmail: true,
      }),
    );
    expect(data.emailSent).toBe(true);
    expect(mail.declined).toEqual([request.email]);
  });

  it("refuses a reason over 500 characters", async () => {
    const request = await pending();
    expect(
      (
        await rejectAccessRequest(admin, {
          requestId: request.id,
          reason: "x".repeat(501),
        })
      ).ok,
    ).toBe(false);
  });

  it("manual WhatsApp entry: pending, source whatsapp; a second pending for the email is refused", async () => {
    const email = nextEmail();
    const data = expectOk(
      await createManualAccessRequest(admin, {
        name: "Chat Person",
        email,
        phone: "+852 9123 4567",
      }),
    );
    expect(
      await AccessRequestModel.findById(data.requestId).lean(),
    ).toMatchObject({ source: "whatsapp", status: "pending", kind: "new" });
    const again = await createManualAccessRequest(admin, {
      name: "Chat Person",
      email,
    });
    expect(again.ok).toBe(false);
  });

  it("deletes handled requests only", async () => {
    const request = await pending();
    expect(
      formErrors(
        await deleteAccessRequest(admin, { requestId: request.id }),
      )[0],
    ).toMatch(/before deleting/);
    expectOk(await rejectAccessRequest(admin, { requestId: request.id }));
    expectOk(await deleteAccessRequest(admin, { requestId: request.id }));
    expect(await AccessRequestModel.exists({ _id: request.id })).toBeNull();
    expect(
      formErrors(await deleteAccessRequest(admin, { requestId: request.id })),
    ).toEqual(["This request no longer exists."]);
  });
});

describe("reads", () => {
  it("lists pending and handled separately, flagging existing customers", async () => {
    await AccessRequestModel.deleteMany({});
    const approved = await pending();
    expectOk(await approveAccessRequest(admin, approveInput(approved.id)));
    const renewal = await pending(approved.email, { kind: "renewal" });
    const fresh = await pending();

    const queue = await listAccessRequests(admin, { tab: "pending" });
    expect(queue.rows.map((row) => row.id).sort()).toEqual(
      [renewal.id, fresh.id].sort(),
    );
    const byId = new Map(queue.rows.map((row) => [row.id, row]));
    expect(byId.get(renewal.id)?.existingCustomer).toBe(true);
    expect(byId.get(fresh.id)?.existingCustomer).toBe(false);
    const handled = await listAccessRequests(admin, { tab: "handled" });
    expect(handled.rows.map((row) => row.id)).toEqual([approved.id]);
  });

  it("getAccessRequest shows the existing account and its invite state", async () => {
    const approved = await pending();
    const created = expectOk(
      await approveAccessRequest(admin, approveInput(approved.id), { now }),
    );
    const again = await pending(approved.email);
    const detail = await getAccessRequest(
      admin,
      { requestId: again.id },
      { now },
    );
    expect(detail?.existingAccount).toMatchObject({
      userId: created.userId,
      isCustomer: true,
      blocked: false,
      invite: { state: "pending" },
    });
    expect(await getAccessRequest(admin, { requestId: "nope" })).toBeNull();
  });
});

describe("audit meta", () => {
  it("holds ids, kinds and counts only: never an email or a name", async () => {
    const entries = await AuditLogModel.find({
      action: { $regex: /^access_request\./ },
    }).lean();
    expect(entries.length).toBeGreaterThan(5);
    const text = JSON.stringify(entries.map((entry) => entry.meta ?? {}));
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/Jane|Acme|Hong Kong|http/);
  });
});
