// Tests for the customer services (src/lib/admin/customers.ts, ADR 0070) on
// the memory replica set with REAL Better Auth: create (role, flag, expiry,
// invite), regenerate invite (expiry untouched, earlier links dead, limited,
// refused while in flight), temporary password (flag + links), ban/unban
// (sessions + epoch), access math, the list filters and their boundaries,
// search escaping, the customer page, and audit meta without emails.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/lib/db";
import {
  acquireLock,
  buildKey,
  hashUserId,
  releaseLock,
} from "@/lib/rate-limit";
import { AccessRequestModel, AuditLogModel, DownloadLogModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import {
  authCall,
  linkCount,
  rawUser,
  seedUserFields,
  sessionCount,
  setupAuthHarness,
  signedInAdmin,
  signIn,
} from "../../../test/helpers/auth-harness";

import {
  banCustomer,
  createCustomer,
  escapeRegex,
  getCustomer,
  getCustomerCounts,
  listCustomers,
  regenerateInvite,
  revokeCustomerSessions,
  sendCustomerResetLink,
  setCustomerAccess,
  setTemporaryPassword,
  TEMPORARY_PASSWORD_LENGTH,
  unbanCustomer,
  updateCustomerProfile,
  type AdminActor,
  type InviteOutcome,
} from "./customers";
import type { ServiceResult } from "./write-result";

const mail = vi.hoisted(() => ({
  invites: [] as { to: string; url: string }[],
  extended: [] as { to: string; accessExpiresAt: Date | null }[],
  resets: [] as string[],
  failInvite: false,
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendInviteEmail: vi.fn(async (input: { to: string; url: string }) => {
    if (mail.failInvite) throw new Error("provider down");
    mail.invites.push({ to: input.to, url: input.url });
    return { id: "email-id" };
  }),
  sendAccessExtendedEmail: vi.fn(
    async (input: { to: string; accessExpiresAt: Date | null }) => {
      mail.extended.push(input);
      return { id: "email-id" };
    },
  ),
  sendPasswordResetEmail: vi.fn(async ({ url }: { url: string }) => {
    mail.resets.push(url);
    return { id: "email-id" };
  }),
}));

const harness = setupAuthHarness("yg_admin_customers_test");
let admin: AdminActor;
let counter = 0;

beforeAll(async () => {
  admin = await signedInAdmin(harness);
}, 120_000);

beforeEach(async () => {
  mail.invites.length = 0;
  mail.extended.length = 0;
  mail.resets.length = 0;
  mail.failInvite = false;
  harness.background.length = 0;
  // Fresh limiter counters, but keep the admin's session.
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

const nextEmail = () => `customer-${++counter}@example.com`;

async function newCustomer(
  fields: Record<string, unknown> = {},
  delivery: "email" | "copy" = "email",
) {
  const email = nextEmail();
  const data = expectOk(
    await createCustomer(admin, {
      name: "Test Customer",
      email,
      company: "Acme Lighting",
      country: "Hong Kong",
      access: { kind: "months", months: 6 },
      delivery,
      ...fields,
    }),
  );
  return { ...data, email };
}

/* Sets the customer's own password through the invite link. */
async function acceptInvite(url: string, password: string) {
  const token = new URL(url).searchParams.get("token");
  const response = await authCall("/reset-password", {
    token,
    newPassword: password,
  });
  expect(response.status).toBe(200);
}

describe("createCustomer", () => {
  it("makes a customer with the flag, the expiry and an emailed invite", async () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const email = nextEmail();
    const data = expectOk(
      await createCustomer(
        admin,
        {
          name: "Jane Doe",
          email: email.toUpperCase(),
          company: "Acme Lighting",
          country: "Hong Kong",
          access: { kind: "months", months: 3 },
        },
        { now },
      ),
    );
    expect(data.accessExpiresAt?.toISOString()).toBe(
      "2027-01-09T23:59:59.999Z",
    );
    expect(data.invite.state).toBe("sent");
    const doc = await rawUser(data.userId);
    expect(doc).toMatchObject({
      email,
      name: "Jane Doe",
      role: "customer",
      mustChangePassword: true,
      company: "Acme Lighting",
      country: "Hong Kong",
      accessExpiresAt: new Date("2027-01-09T23:59:59.999Z"),
    });
    expect(doc?.invitedAt).toBeInstanceOf(Date);
    expect(mail.invites).toEqual([{ to: email, url: expect.any(String) }]);
    expect(await linkCount(data.userId)).toBe(1);
  });

  it("no expiry is stored as null", async () => {
    const data = expectOk(
      await createCustomer(admin, {
        name: "No End",
        email: nextEmail(),
        access: { kind: "none" },
      }),
    );
    expect((await rawUser(data.userId))?.accessExpiresAt).toBeNull();
  });

  it("copy mode returns the link once and sends no email", async () => {
    const created = await newCustomer({}, "copy");
    const invite = created.invite as Extract<InviteOutcome, { state: "copy" }>;
    expect(invite.state).toBe("copy");
    expect(invite.url).toMatch(/\/reset-password\?token=.+&invite=1$/);
    expect(mail.invites).toHaveLength(0);
  });

  it("a taken email is refused; never a second account", async () => {
    const first = await newCustomer();
    const again = await createCustomer(admin, {
      name: "Again",
      email: first.email,
      access: { kind: "none" },
    });
    expect(again.ok).toBe(false);
    expect(
      await getDb().collection("users").countDocuments({ email: first.email }),
    ).toBe(1);
  });

  it("a failed invite email still creates and audits the account", async () => {
    mail.failInvite = true;
    const created = await newCustomer();
    expect(created.invite.state).toBe("send_failed");
    expect(
      await AuditLogModel.countDocuments({
        action: "customer.create",
        "target.id": created.userId,
      }),
    ).toBe(1);
  });

  it("refuses invalid input before any write", async () => {
    const before = await getDb().collection("users").countDocuments();
    const result = await createCustomer(admin, {
      name: "<script>",
      email: "not-an-email",
      access: { kind: "months", months: 5 },
    });
    expect(result.ok).toBe(false);
    expect(await getDb().collection("users").countDocuments()).toBe(before);
  });
});

describe("regenerateInvite", () => {
  it("makes a new link, kills the old one and never changes the expiry", async () => {
    const created = await newCustomer();
    const before = await rawUser(created.userId);
    const first = mail.invites[0]?.url ?? "";

    const data = expectOk(
      await regenerateInvite(admin, {
        userId: created.userId,
        delivery: "copy",
      }),
    );
    const invite = data.invite as Extract<InviteOutcome, { state: "copy" }>;
    expect(invite.url).not.toBe(first);
    const after = await rawUser(created.userId);
    expect(after?.accessExpiresAt).toEqual(before?.accessExpiresAt);
    expect(after?.mustChangePassword).toBe(true);
    expect(await linkCount(created.userId)).toBe(1);

    // The old link is dead; the new one sets the password.
    const old = await authCall("/reset-password", {
      token: new URL(first).searchParams.get("token"),
      newPassword: "customer-own-password-1",
    });
    expect(old.status).toBe(400);
    await acceptInvite(invite.url, "customer-own-password-1");
    expect((await rawUser(created.userId))?.mustChangePassword).toBe(false);
  });

  it("is limited to 10 per customer per hour", async () => {
    const created = await newCustomer(); // the create used 1 of 10
    for (let i = 0; i < 9; i++) {
      expectOk(
        await regenerateInvite(admin, {
          userId: created.userId,
          delivery: "copy",
        }),
      );
    }
    const refused = await regenerateInvite(admin, {
      userId: created.userId,
      delivery: "copy",
    });
    expect(formErrors(refused)[0]).toMatch(/Too many new links/);
  });

  it("is refused while another invite for the customer is in flight", async () => {
    const created = await newCustomer();
    const lock = buildKey("invite-lock", hashUserId(created.userId));
    const owner = await acquireLock(lock, 30);
    const refused = await regenerateInvite(admin, { userId: created.userId });
    expect(formErrors(refused)[0]).toMatch(/already being made/);
    await releaseLock(lock, owner ?? "");
    expectOk(await regenerateInvite(admin, { userId: created.userId }));
  });

  it("is refused for a blocked customer, an unknown id and the admin", async () => {
    const created = await newCustomer();
    expectOk(
      await banCustomer(admin, { userId: created.userId, reason: "Spam" }),
    );
    expect(
      formErrors(await regenerateInvite(admin, { userId: created.userId }))[0],
    ).toMatch(/Unblock/);
    expect((await regenerateInvite(admin, { userId: "0".repeat(24) })).ok).toBe(
      false,
    );
    expect((await regenerateInvite(admin, { userId: admin.id })).ok).toBe(
      false,
    );
  });
});

describe("setTemporaryPassword", () => {
  it("returns a one-time password, sets the flag, kills links and sessions", async () => {
    const created = await newCustomer();
    await acceptInvite(mail.invites[0]?.url ?? "", "customer-own-password-2");
    const cookie = await signIn(created.email, "customer-own-password-2");
    expect(cookie).not.toBe("");
    expect(await sessionCount(created.userId)).toBe(1);
    expectOk(
      await regenerateInvite(admin, {
        userId: created.userId,
        delivery: "copy",
      }),
    );
    const epoch = Number((await rawUser(created.userId))?.deviceEpoch ?? 0);

    const { password } = expectOk(
      await setTemporaryPassword(admin, { userId: created.userId }),
    );
    expect(password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
    const doc = await rawUser(created.userId);
    expect(doc?.mustChangePassword).toBe(true);
    expect(doc?.invitedAt).toBeNull();
    expect(doc?.inviteExpiresAt).toBeNull();
    expect(doc?.deviceEpoch).toBe(epoch + 1);
    expect(await linkCount(created.userId)).toBe(0);
    expect(await sessionCount(created.userId)).toBe(0);
    // The temporary password works (and leads to /change-password).
    expect(await signIn(created.email, password)).not.toBe("");
    // Never in the audit log.
    const entries = await AuditLogModel.find({
      "target.id": created.userId,
    }).lean();
    expect(JSON.stringify(entries)).not.toContain(password);
  });
});

describe("ban / unban / sessions", () => {
  it("ban ends every session and bumps the device epoch; unban lifts it", async () => {
    const created = await newCustomer();
    await acceptInvite(mail.invites[0]?.url ?? "", "customer-own-password-3");
    await signIn(created.email, "customer-own-password-3");
    await signIn(created.email, "customer-own-password-3");
    expect(await sessionCount(created.userId)).toBe(2);
    const epoch = Number((await rawUser(created.userId))?.deviceEpoch ?? 0);

    expectOk(
      await banCustomer(admin, {
        userId: created.userId,
        reason: "Shared the files",
      }),
    );
    const banned = await rawUser(created.userId);
    expect(banned).toMatchObject({
      banned: true,
      banReason: "Shared the files",
    });
    expect(banned?.deviceEpoch).toBe(epoch + 1);
    expect(await sessionCount(created.userId)).toBe(0);
    const audit = await AuditLogModel.findOne({
      action: "customer.ban",
      "target.id": created.userId,
    }).lean();
    expect(JSON.stringify(audit)).not.toContain("Shared the files");

    expectOk(await unbanCustomer(admin, { userId: created.userId }));
    expect((await rawUser(created.userId))?.banned).toBe(false);
    // A second unban changes nothing (no audit entry).
    const again = expectOk(
      await unbanCustomer(admin, { userId: created.userId }),
    );
    expect(again.userId).toBe(created.userId);
    expect(
      await AuditLogModel.countDocuments({
        action: "customer.unban",
        "target.id": created.userId,
      }),
    ).toBe(1);
  });

  it("ban needs a reason", async () => {
    const created = await newCustomer();
    expect(
      (await banCustomer(admin, { userId: created.userId, reason: " " })).ok,
    ).toBe(false);
  });

  it("revokeCustomerSessions ends the sessions", async () => {
    const created = await newCustomer();
    await acceptInvite(mail.invites[0]?.url ?? "", "customer-own-password-4");
    await signIn(created.email, "customer-own-password-4");
    expectOk(await revokeCustomerSessions(admin, { userId: created.userId }));
    expect(await sessionCount(created.userId)).toBe(0);
  });
});

describe("setCustomerAccess (plan Q5)", () => {
  it("extends from the later of today and the current end, end of day UTC", async () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const created = await newCustomer({
      access: { kind: "date", date: "2026-12-31" },
    });
    const data = expectOk(
      await setCustomerAccess(
        admin,
        { userId: created.userId, access: { kind: "months", months: 3 } },
        { now },
      ),
    );
    expect(data.accessExpiresAt?.toISOString()).toBe(
      "2027-03-31T23:59:59.999Z",
    );
    expect(data.notified).toBe(true);
    expect(mail.extended).toEqual([
      {
        to: created.email,
        name: expect.any(String),
        accessExpiresAt: data.accessExpiresAt,
      },
    ]);
  });

  it("an expired customer is extended from today", async () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const created = await newCustomer({
      access: { kind: "date", date: "2026-01-01" },
    });
    const data = expectOk(
      await setCustomerAccess(
        admin,
        {
          userId: created.userId,
          access: { kind: "months", months: 12 },
          notify: false,
        },
        { now },
      ),
    );
    expect(data.accessExpiresAt?.toISOString()).toBe(
      "2027-10-09T23:59:59.999Z",
    );
    expect(mail.extended).toHaveLength(0);
  });

  it("a past custom date ends access and sends no 'extended' email", async () => {
    const created = await newCustomer();
    const data = expectOk(
      await setCustomerAccess(admin, {
        userId: created.userId,
        access: { kind: "date", date: "2020-01-01" },
      }),
    );
    expect(data.notified).toBe(false);
    expect((await rawUser(created.userId))?.accessExpiresAt).toEqual(
      new Date("2020-01-01T23:59:59.999Z"),
    );
  });

  it("never says 'extended' when access was shortened, unchanged or the customer is blocked", async () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    const created = await newCustomer({
      access: { kind: "date", date: "2027-06-30" },
    });
    const shortened = expectOk(
      await setCustomerAccess(
        admin,
        {
          userId: created.userId,
          access: { kind: "date", date: "2026-11-01" },
        },
        { now },
      ),
    );
    expect(shortened.notified).toBe(false);
    const same = expectOk(
      await setCustomerAccess(
        admin,
        {
          userId: created.userId,
          access: { kind: "date", date: "2026-11-01" },
        },
        { now },
      ),
    );
    expect(same.notified).toBe(false);
    expectOk(
      await banCustomer(admin, { userId: created.userId, reason: "Paused" }),
    );
    const blocked = expectOk(
      await setCustomerAccess(
        admin,
        { userId: created.userId, access: { kind: "months", months: 12 } },
        { now },
      ),
    );
    expect(blocked.notified).toBe(false);
    expect(mail.extended).toHaveLength(0);
  });

  it("does not touch the invite", async () => {
    const created = await newCustomer();
    const before = await rawUser(created.userId);
    expectOk(
      await setCustomerAccess(admin, {
        userId: created.userId,
        access: { kind: "none" },
      }),
    );
    const after = await rawUser(created.userId);
    expect(after?.invitedAt).toEqual(before?.invitedAt);
    expect(await linkCount(created.userId)).toBe(1);
  });
});

describe("profile and reset link", () => {
  it("updates name, company and country; an identical save is a no-op", async () => {
    const created = await newCustomer();
    expectOk(
      await updateCustomerProfile(admin, {
        userId: created.userId,
        name: "Renamed Person",
        company: "",
        country: "Macau",
      }),
    );
    expect(await rawUser(created.userId)).toMatchObject({
      name: "Renamed Person",
      company: null,
      country: "Macau",
    });
    const entries = () =>
      AuditLogModel.countDocuments({
        action: "customer.update",
        "target.id": created.userId,
      });
    expect(await entries()).toBe(1);
    expectOk(
      await updateCustomerProfile(admin, {
        userId: created.userId,
        name: "Renamed Person",
        company: "",
        country: "Macau",
      }),
    );
    expect(await entries()).toBe(1);
  });

  it("emails a normal reset link through Better Auth", async () => {
    const created = await newCustomer();
    expectOk(await sendCustomerResetLink(admin, { userId: created.userId }));
    await Promise.all(harness.background);
    expect(mail.resets).toHaveLength(1);
  });
});

describe("listCustomers (plan Q10)", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");
  const DAY = 86_400_000;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await getDb()
      .collection("users")
      .deleteMany({ role: { $ne: "admin" } });
    const make = async (label: string, fields: Record<string, unknown>) => {
      const { user } = await harness.auth.api.createUser({
        body: {
          email: `list-${label}@example.com`,
          password: "list-password-12345",
          name: `List ${label.replace(/[^a-z]/gi, "")}`,
          role: "customer",
        },
      });
      await seedUserFields(user.id, {
        company: `Company ${label}`,
        ...fields,
      });
      ids[label] = user.id;
    };
    const at = (ms: number) => new Date(now.getTime() + ms);
    await make("noexpiry", { accessExpiresAt: null });
    await make("active", { accessExpiresAt: at(60 * DAY) });
    await make("expiring30", { accessExpiresAt: at(30 * DAY) });
    await make("expiring31", { accessExpiresAt: at(30 * DAY + 1) });
    await make("expiredNow", { accessExpiresAt: at(0) });
    await make("blocked", {
      accessExpiresAt: at(60 * DAY),
      banned: true,
      banExpires: null,
    });
    await make("banEnded", {
      accessExpiresAt: at(60 * DAY),
      banned: true,
      banExpires: at(-1),
    });
    await make("invitePending", {
      invitedAt: at(-DAY),
      inviteExpiresAt: at(1),
    });
    await make("inviteExpired", {
      invitedAt: at(-3 * DAY),
      inviteExpiresAt: at(0),
    });
    await make("inviteAccepted", {
      invitedAt: at(-3 * DAY),
      inviteExpiresAt: at(0),
      passwordSetAt: at(-3 * DAY),
    });
    await make("reinvited", {
      invitedAt: at(-DAY),
      inviteExpiresAt: at(-1),
      passwordSetAt: at(-2 * DAY),
    });
    await make("search.dot", { company: "A.C Lighting" });
    await make("searchabc", { company: "ABC Lighting" });
    // Never listed: an account holding both roles.
    const { user } = await harness.auth.api.createUser({
      body: {
        email: "list-both@example.com",
        password: "list-password-12345",
        name: "List both",
        role: ["customer", "admin"],
      },
    });
    ids.both = user.id;
  }, 120_000);

  const listIds = async (input: Record<string, unknown>) =>
    (await listCustomers(input, { now })).rows.map((row) => row.id).sort();
  const pick = (...labels: string[]) =>
    labels.map((label) => ids[label]).sort();

  it("lists customers only, never the admin or a mixed-role account", async () => {
    const all = await listIds({});
    expect(all).toHaveLength(13);
    expect(all).not.toContain(admin.id);
    expect(all).not.toContain(ids.both);
  });

  it("blocked: banned with no end; an ended ban is not blocked", async () => {
    expect(await listIds({ status: "blocked" })).toEqual(pick("blocked"));
  });

  it("expiring: ends within 30 days (30 d exactly in, 30 d + 1 ms out)", async () => {
    expect(await listIds({ status: "expiring" })).toEqual(pick("expiring30"));
  });

  it("expired: ended at or before now, not blocked", async () => {
    expect(await listIds({ status: "expired" })).toEqual(pick("expiredNow"));
  });

  it("active: not blocked and not ended (includes no expiry and expiring)", async () => {
    const active = await listIds({ status: "active" });
    expect(active).toContain(ids.noexpiry);
    expect(active).toContain(ids.expiring30);
    expect(active).toContain(ids.banEnded);
    expect(active).not.toContain(ids.blocked);
    expect(active).not.toContain(ids.expiredNow);
  });

  it("invite pending / expired use invitedAt vs passwordSetAt and the 72 h end", async () => {
    expect(await listIds({ status: "invite_pending" })).toEqual(
      pick("invitePending"),
    );
    expect(await listIds({ status: "invite_expired" })).toEqual(
      pick("inviteExpired", "reinvited"),
    );
  });

  it("the row states agree with the filters", async () => {
    const rows = (await listCustomers({}, { now })).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(ids.invitePending ?? "")?.invite.state).toBe("pending");
    expect(byId.get(ids.inviteExpired ?? "")?.invite.state).toBe("expired");
    expect(byId.get(ids.inviteAccepted ?? "")?.invite.state).toBe("accepted");
    expect(byId.get(ids.expiring30 ?? "")?.access).toBe("expiring");
    expect(byId.get(ids.expiredNow ?? "")?.access).toBe("expired");
    expect(byId.get(ids.blocked ?? "")?.blocked).toBe(true);
    expect(byId.get(ids.banEnded ?? "")?.blocked).toBe(false);
  });

  it("search is escaped: '.' is a dot, '(' does not break the query", async () => {
    expect(await listIds({ q: "A.C" })).toEqual(pick("search.dot"));
    expect(await listIds({ q: "(" })).toEqual([]);
    expect(await listIds({ q: "list-active@" })).toEqual(pick("active"));
    expect(escapeRegex("a.b*c(d)")).toBe("a\\.b\\*c\\(d\\)");
  });

  it("sorts by expiry (soonest first, no expiry last) and by name", async () => {
    const byExpiry = (await listCustomers({ sort: "expiry" }, { now })).rows;
    expect(byExpiry[0]?.id).toBe(ids.expiredNow);
    expect(byExpiry.at(-1)?.accessExpiresAt).toBeNull();
    const names = (await listCustomers({ sort: "name" }, { now })).rows.map(
      (row) => row.name.toLowerCase(),
    );
    expect(names).toEqual([...names].sort());
  });

  it("bad input falls back to the first page of everything", async () => {
    const page = await listCustomers(
      { status: "nope", sort: "evil", page: -3 },
      { now },
    );
    expect(page.page).toBe(1);
    expect(page.total).toBe(13);
  });

  it("dashboard counts match the filters", async () => {
    expect(await getCustomerCounts({ now })).toEqual({
      expiringSoon: 1,
      invitesExpired: 2,
    });
  });
});

describe("getCustomer", () => {
  it("shows the profile, history, linked requests and audit trail", async () => {
    const created = await newCustomer();
    await AccessRequestModel.create({
      name: "Linked",
      email: created.email,
      source: "form",
      status: "approved",
    });
    await DownloadLogModel.collection.insertOne({
      user: (await rawUser(created.userId))?._id,
      product: (await rawUser(created.userId))?._id,
      datasheet: (await rawUser(created.userId))?._id,
      downloadedAt: new Date(),
    });
    const page = await getCustomer({ userId: created.userId });
    expect(page?.customer).toMatchObject({
      id: created.userId,
      email: created.email,
      mustChangePassword: true,
      blocked: false,
    });
    expect(page?.customer.invite.state).toBe("pending");
    expect(page?.requests).toHaveLength(1);
    expect(page?.downloads.total).toBe(1);
    expect(page?.audit.map((entry) => entry.action)).toContain(
      "customer.create",
    );
    expect(JSON.stringify(page?.customer)).not.toContain("deviceEpoch");
  });

  it("null for an unknown id, a malformed id and the admin", async () => {
    expect(await getCustomer({ userId: "0".repeat(24) })).toBeNull();
    expect(await getCustomer({ userId: "nope" })).toBeNull();
    expect(await getCustomer({ userId: admin.id })).toBeNull();
  });
});

describe("the actor must be a real signed-in admin (second line behind requireAdmin)", () => {
  it("a forged actor (admin id, no session) changes nothing through Better Auth", async () => {
    const victim = await newCustomer();
    const forged: AdminActor = { id: admin.id, headers: new Headers() };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await banCustomer(forged, { userId: victim.userId, reason: "x" })).ok,
    ).toBe(false);
    expect(
      (await setTemporaryPassword(forged, { userId: victim.userId })).ok,
    ).toBe(false);
    expect(
      (await revokeCustomerSessions(forged, { userId: victim.userId })).ok,
    ).toBe(false);
    expect(
      (
        await createCustomer(forged, {
          name: "Forged",
          email: nextEmail(),
          access: { kind: "none" },
        })
      ).ok,
    ).toBe(false);
    expect((await rawUser(victim.userId))?.banned).not.toBe(true);
  });

  it("a customer's own session can't act as the admin", async () => {
    const victim = await newCustomer();
    const attacker = await newCustomer();
    await acceptInvite(
      mail.invites.at(-1)?.url ?? "",
      "attacker-own-password-1",
    );
    const cookie = await signIn(attacker.email, "attacker-own-password-1");
    const posing: AdminActor = {
      id: admin.id,
      headers: new Headers({ cookie }),
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await banCustomer(posing, { userId: victim.userId, reason: "x" })).ok,
    ).toBe(false);
    expect(
      (await setTemporaryPassword(posing, { userId: victim.userId })).ok,
    ).toBe(false);
    expect((await rawUser(victim.userId))?.banned).not.toBe(true);
  });

  // Documented boundary: updateCustomerProfile and setCustomerAccess write
  // through account-writes.ts, not a Better Auth admin endpoint, so the
  // Server Action's requireAdmin() is their only role check (the P7/P8
  // action guard tests cover it).
});

describe("one-time credentials survive a failed audit write (ADR 0070)", () => {
  it("the temporary password and the copy link are still returned, flagged", async () => {
    const created = await newCustomer();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AuditLogModel, "create").mockRejectedValue(new Error("down"));
    const temp = expectOk(
      await setTemporaryPassword(admin, { userId: created.userId }),
    );
    expect(temp.auditFailed).toBe(true);
    expect(temp.password).toHaveLength(TEMPORARY_PASSWORD_LENGTH);
    const invite = expectOk(
      await regenerateInvite(admin, {
        userId: created.userId,
        delivery: "copy",
      }),
    );
    expect(invite.auditFailed).toBe(true);
    expect(invite.invite.state).toBe("copy");
  });
});

describe("audit meta", () => {
  it("holds ids, kinds and counts only: never an email, name or secret", async () => {
    const entries = await AuditLogModel.find({
      action: { $regex: /^customer\./ },
    }).lean();
    expect(entries.length).toBeGreaterThan(5);
    const text = JSON.stringify(entries.map((entry) => entry.meta ?? {}));
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/Test Customer|Acme|Hong Kong|token|http/);
  });
});
