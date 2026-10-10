// QA gate A (Phase 5, P1-P5): the admin services, token handling,
// enumeration and log hygiene, on the memory replica set with REAL Better
// Auth (test/helpers/auth-harness.ts).
//
// 1. Defense in depth (rule 3): the P3 services are documented as "called
//    only from requireAdmin() actions" (ADR 0069/0070). These tests call
//    each write service with a signed-in CUSTOMER as the actor, i.e. what
//    happens if one P7/P8 action ever forgets requireAdmin(). Services that
//    reach a Better Auth admin endpoint are refused by Better Auth itself;
//    the ones that write through account-writes.ts or Mongoose only were
//    NOT (finding M-1). Fixed: every service now re-checks the actor's
//    session from the database first (src/lib/admin/actor.ts).
// 2. Enumeration: forgot-password answers the same for known and unknown
//    emails (status, body, limit sequence) and never waits for the email.
// 3. Token handling: invite tokens are stored hashed, a completed invite
//    revokes every session, and Better Auth refuses foreign redirect
//    targets on the reset endpoints (no open redirect).
// 4. Logs: no email, name, token or link in any log line, even when the
//    email provider fails with a message that quotes the address.

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveAccessRequest,
  createManualAccessRequest,
  deleteAccessRequest,
  rejectAccessRequest,
} from "@/lib/admin/access-requests";
import {
  banCustomer,
  createCustomer,
  regenerateInvite,
  revokeCustomerSessions,
  sendCustomerResetLink,
  setCustomerAccess,
  setTemporaryPassword,
  unbanCustomer,
  updateCustomerProfile,
  type AdminActor,
} from "@/lib/admin/customers";
import type { ServiceResult } from "@/lib/admin/write-result";
import { handleAuthRequest } from "@/lib/auth-handler";
import { getDb } from "@/lib/db";
import { createInviteLink } from "@/lib/invite";
import { safeNextPath } from "@/lib/safe-next-path";
import { AccessRequestModel, AuditLogModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";

import {
  AUTH_BASE,
  authCall,
  freshIp,
  linkCount,
  rawUser,
  seedUserFields,
  sessionCount,
  setupAuthHarness,
  signedInAdmin,
  signIn,
} from "./helpers/auth-harness";

const mail = vi.hoisted(() => ({
  invites: [] as { to: string; url: string }[],
  resets: [] as { to: string; url: string }[],
  failAll: false,
}));
vi.mock("@/lib/email", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/email")>();
  /* A provider failure whose message quotes the address (worst case). */
  const fail = (to: string) => {
    throw new Error(`provider refused ${to}`);
  };
  return {
    ...real,
    sendInviteEmail: vi.fn(async (input: { to: string; url: string }) => {
      if (mail.failAll) fail(input.to);
      mail.invites.push({ to: input.to, url: input.url });
      return { id: "email-id" };
    }),
    sendPasswordResetEmail: vi.fn(
      async (input: { to: string; url: string }) => {
        if (mail.failAll) fail(input.to);
        mail.resets.push({ to: input.to, url: input.url });
        return { id: "email-id" };
      },
    ),
    sendAccessExtendedEmail: vi.fn(async (input: { to: string }) => {
      if (mail.failAll) fail(input.to);
      return { id: "email-id" };
    }),
    sendAccessDeclinedEmail: vi.fn(async (input: { to: string }) => {
      if (mail.failAll) fail(input.to);
      return { id: "email-id" };
    }),
  };
});

const harness = setupAuthHarness("yg_phase5_gate_a_services_qa");
let admin: AdminActor;
let counter = 0;
const nextEmail = (tag: string) => `gate-a-${tag}-${++counter}@example.com`;

beforeAll(async () => {
  admin = await signedInAdmin(harness, "gate-a-admin@example.com");
}, 120_000);

beforeEach(async () => {
  mail.invites.length = 0;
  mail.resets.length = 0;
  mail.failAll = false;
  harness.background.length = 0;
  await LoginAttemptModel.deleteMany({});
});

/** A customer with their own password, signed in; returns them as an actor. */
async function signedInCustomer(
  tag: string,
  fields: Record<string, unknown> = {},
): Promise<AdminActor & { email: string }> {
  const email = nextEmail(tag);
  const password = `${tag}-customer-password-1`;
  const { user } = await harness.auth.api.createUser({
    body: {
      email,
      password,
      name: `Customer ${tag}`,
      role: "customer",
      data: {
        mustChangePassword: false,
        accessExpiresAt: new Date(Date.now() - 1000),
      },
    },
  });
  if (Object.keys(fields).length > 0) await seedUserFields(user.id, fields);
  const cookie = await signIn(email, password);
  return {
    id: user.id,
    email,
    headers: new Headers({ cookie, origin: AUTH_BASE }),
  };
}

/** A customer nobody is signed in as (the target of an attack). */
async function victim(tag: string) {
  const email = nextEmail(tag);
  const { user } = await harness.auth.api.createUser({
    body: {
      email,
      password: `${tag}-victim-password-12`,
      name: `Victim ${tag}`,
      role: "customer",
      data: { mustChangePassword: false, accessExpiresAt: null },
    },
  });
  return { id: user.id, email };
}

const isRefused = <T>(result: ServiceResult<T>) => !result.ok;

/** Every field and side effect a refused write must leave as it was. */
async function snapshot(userId: string) {
  const doc = await rawUser(userId);
  return {
    user: {
      name: doc?.name,
      mustChangePassword: doc?.mustChangePassword,
      accessExpiresAt: doc?.accessExpiresAt ?? null,
      invitedAt: doc?.invitedAt ?? null,
      banned: doc?.banned ?? null,
      company: doc?.company ?? null,
    },
    links: await linkCount(userId),
    sessions: await sessionCount(userId),
  };
}

// ---------------------------------------------------------------------------
// 1. Defense in depth: a customer as the "admin actor"
// ---------------------------------------------------------------------------

describe("admin services with a customer as the actor (a forgotten requireAdmin)", () => {
  describe("refused by Better Auth's own admin check (real today)", () => {
    it("createCustomer creates no account", async () => {
      const attacker = await signedInCustomer("create");
      const email = nextEmail("created-by-customer");
      const result = await createCustomer(attacker, {
        name: "Sneaky",
        email,
        company: "Acme",
        country: "Hong Kong",
        access: { kind: "none" },
        delivery: "copy",
      });
      expect(isRefused(result)).toBe(true);
      expect(await getDb().collection("users").countDocuments({ email })).toBe(
        0,
      );
    });

    it("banCustomer, unbanCustomer and revokeCustomerSessions change nothing", async () => {
      const attacker = await signedInCustomer("ban");
      const target = await signedInCustomer("ban-target");
      const before = await snapshot(target.id);
      expect(
        isRefused(
          await banCustomer(attacker, { userId: target.id, reason: "x" }),
        ),
      ).toBe(true);
      expect(
        isRefused(
          await revokeCustomerSessions(attacker, { userId: target.id }),
        ),
      ).toBe(true);
      await seedUserFields(target.id, { banned: true, banExpires: null });
      expect(
        isRefused(await unbanCustomer(attacker, { userId: target.id })),
      ).toBe(true);
      const after = await snapshot(target.id);
      expect(after.sessions).toBe(before.sessions);
      expect((await rawUser(target.id))?.banned).toBe(true);
    });
  });

  // M-1 (fixed): these services never reach a Better Auth admin endpoint
  // (or reach it only after their own writes); the service's own actor
  // check (src/lib/admin/actor.ts) now refuses a non-admin first.
  describe("refused by the services' own actor check (finding M-1, fixed)", () => {
    it("regenerateInvite (copy) hands a customer another customer's invite link", async () => {
      const attacker = await signedInCustomer("invite");
      const target = await victim("invite-target");
      const result = await regenerateInvite(attacker, {
        userId: target.id,
        delivery: "copy",
      });
      expect(isRefused(result)).toBe(true);
      expect(await linkCount(target.id)).toBe(0);
    });

    it("setCustomerAccess lets a customer re-open their own expired access", async () => {
      const attacker = await signedInCustomer("access");
      const result = await setCustomerAccess(attacker, {
        userId: attacker.id,
        access: { kind: "none" },
        notify: false,
      });
      expect(isRefused(result)).toBe(true);
      expect((await rawUser(attacker.id))?.accessExpiresAt).not.toBeNull();
    });

    it("updateCustomerProfile lets a customer rename another customer", async () => {
      const attacker = await signedInCustomer("profile");
      const target = await victim("profile-target");
      const result = await updateCustomerProfile(attacker, {
        userId: target.id,
        name: "Renamed",
        company: "Acme",
        country: "Hong Kong",
      });
      expect(isRefused(result)).toBe(true);
      expect((await rawUser(target.id))?.name).toBe("Victim profile-target");
    });

    it("setTemporaryPassword is refused but has already flagged the target and killed its links", async () => {
      const attacker = await signedInCustomer("temp");
      const target = await victim("temp-target");
      // The target has a live forgot-password link.
      const reset = await authCall("/request-password-reset", {
        email: target.email,
        redirectTo: "/reset-password",
      });
      expect(reset.status).toBe(200);
      await Promise.all(harness.background);
      const before = await snapshot(target.id);
      expect(before.links).toBe(1);
      const result = await setTemporaryPassword(attacker, {
        userId: target.id,
      });
      expect(isRefused(result)).toBe(true);
      // ...and step 1 (account-writes) never ran:
      expect(await snapshot(target.id)).toEqual(before);
    });

    it("sendCustomerResetLink is not refused, and is audited as an admin action by the customer", async () => {
      const attacker = await signedInCustomer("reset-link");
      const target = await victim("reset-link-target");
      const result = await sendCustomerResetLink(attacker, {
        userId: target.id,
      });
      expect(isRefused(result)).toBe(true);
      expect(
        await AuditLogModel.countDocuments({
          action: "customer.password.link",
          actor: new Types.ObjectId(attacker.id),
        }),
      ).toBe(0);
    });

    it("approveAccessRequest lets a customer approve their own renewal", async () => {
      const attacker = await signedInCustomer("approve");
      const request = await AccessRequestModel.create({
        name: "Customer approve",
        email: attacker.email,
        company: "Acme",
        country: "Hong Kong",
        kind: "renewal",
        source: "form",
        status: "pending",
        consentAt: new Date(),
      });
      const result = await approveAccessRequest(attacker, {
        requestId: request._id.toHexString(),
        name: "Customer approve",
        company: "Acme",
        country: "Hong Kong",
        access: { kind: "none" },
        delivery: "copy",
        notifyExtension: false,
      });
      expect(isRefused(result)).toBe(true);
      expect((await rawUser(attacker.id))?.accessExpiresAt).not.toBeNull();
    });

    it("reject, manual entry and delete run for a customer actor", async () => {
      const attacker = await signedInCustomer("queue");
      const pending = await AccessRequestModel.create({
        name: "Someone",
        email: nextEmail("queue-pending"),
        company: "Acme",
        country: "Hong Kong",
        source: "form",
        status: "pending",
        consentAt: new Date(),
      });
      const results = [
        await rejectAccessRequest(attacker, {
          requestId: pending._id.toHexString(),
        }),
        await createManualAccessRequest(attacker, {
          name: "Injected",
          email: nextEmail("queue-manual"),
        }),
        await deleteAccessRequest(attacker, {
          requestId: pending._id.toHexString(),
        }),
      ];
      expect(results.every(isRefused)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Enumeration: forgot-password
// ---------------------------------------------------------------------------

describe("forgot-password answers the same for known and unknown emails", () => {
  it("same status and body; the email send never blocks the answer", async () => {
    const known = await victim("forgot-known");
    const unknown = nextEmail("forgot-unknown");
    const a = await authCall("/request-password-reset", {
      email: known.email,
      redirectTo: "/reset-password",
    });
    const tasksAfterKnown = harness.background.length;
    const b = await authCall("/request-password-reset", {
      email: unknown,
      redirectTo: "/reset-password",
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(a.status);
    expect(await b.text()).toBe(await a.text());
    // The known address's email was handed to the background runner (after
    // the response), so the answer's timing doesn't include the provider.
    expect(tasksAfterKnown).toBeGreaterThan(0);
    await Promise.all(harness.background);
    expect(mail.resets.map((m) => m.to)).toEqual([known.email]);
  });

  it("the per-email limit trips at the same request for both", async () => {
    const known = await victim("forgot-limit-known");
    const unknown = nextEmail("forgot-limit-unknown");
    const run = async (email: string) => {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const response = await authCall("/request-password-reset", {
          email,
          redirectTo: "/reset-password",
        });
        statuses.push(response.status);
      }
      return statuses;
    };
    const knownStatuses = await run(known.email);
    const unknownStatuses = await run(unknown);
    expect(knownStatuses).toEqual(unknownStatuses);
    expect(knownStatuses).toContain(429);
  });
});

// ---------------------------------------------------------------------------
// 3. Token handling
// ---------------------------------------------------------------------------

describe("invite and reset tokens", () => {
  it("are stored hashed: no verifications row holds the token", async () => {
    const target = await victim("hashed");
    const link = await createInviteLink(target.id);
    const token = new URL(link.url).searchParams.get("token") ?? "";
    expect(token.length).toBeGreaterThanOrEqual(43);
    const rows = await getDb()
      .collection("verifications")
      .find({ value: target.id })
      .toArray();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("a completed invite revokes every session of the account", async () => {
    const target = await signedInCustomer("invite-sessions", {
      mustChangePassword: true,
    });
    await signIn(target.email, "invite-sessions-customer-password-1");
    expect(await sessionCount(target.id)).toBe(2);
    const link = await createInviteLink(target.id);
    const response = await authCall("/reset-password", {
      token: new URL(link.url).searchParams.get("token"),
      newPassword: "a-brand-new-password-123",
    });
    expect(response.status).toBe(200);
    expect(await sessionCount(target.id)).toBe(0);
    expect((await rawUser(target.id))?.mustChangePassword).toBe(false);
    expect(await linkCount(target.id)).toBe(0);
  });

  it("the reset callback refuses a foreign callbackURL (no open redirect)", async () => {
    const target = await victim("callback");
    const link = await createInviteLink(target.id);
    const token = new URL(link.url).searchParams.get("token") ?? "";
    for (const callbackURL of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "https:evil.example",
    ]) {
      const response = await handleAuthRequest(
        new Request(
          `${AUTH_BASE}/api/auth/reset-password/${token}?${new URLSearchParams({ callbackURL })}`,
          { headers: { "x-vercel-forwarded-for": freshIp() } },
        ),
      );
      const location = response.headers.get("location") ?? "";
      expect(location, callbackURL).not.toContain("evil.example");
    }
  });

  it("request-password-reset refuses a foreign redirectTo and sends nothing", async () => {
    const target = await victim("redirect-to");
    const response = await authCall("/request-password-reset", {
      email: target.email,
      redirectTo: "https://evil.example/reset",
    });
    expect(response.status).toBe(403);
    await Promise.all(harness.background);
    expect(mail.resets).toHaveLength(0);
    expect(await linkCount(target.id)).toBe(0);
  });

  it("safeNextPath refuses the usual open-redirect vectors", () => {
    for (const raw of [
      "//evil.example",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "/%252F%252Fevil.example",
      "/%5Cevil.example",
      "/%09/evil.example",
      "/\t/evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/%E2%80%A8//evil.example",
      "\\\\evil.example",
    ]) {
      expect(safeNextPath(raw), raw).toBeNull();
    }
    expect(safeNextPath("/product/arc-ar-013a?model=AR-013A1")).toBe(
      "/product/arc-ar-013a?model=AR-013A1",
    );
  });

  // L-2 (fixed): a dot segment before "//" used to pass every check, and the
  // URL parser resolves it to the path "//evil.example" (same origin, but
  // one `new URL(next, base).pathname` away from an open redirect).
  it("safeNextPath refuses dot segments that resolve to a // path", () => {
    for (const raw of [
      "/..//evil.example",
      "/.//evil.example",
      "/a/..//evil.example",
      "/%2e%2e//evil.example",
    ]) {
      expect(safeNextPath(raw), raw).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Logs free of personal data
// ---------------------------------------------------------------------------

describe("logs never carry an email, a name, a token or a link", () => {
  it("across create, regenerate, approve, reset and failing emails", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    try {
      mail.failAll = true;
      const email = nextEmail("logs-create");
      const created = await createCustomer(admin, {
        name: "Loggable Person",
        email,
        company: "Secret Co",
        country: "Hong Kong",
        access: { kind: "months", months: 3 },
        delivery: "email",
      });
      expect(created.ok).toBe(true);
      const userId = created.ok ? created.data.userId : "";
      const copy = await regenerateInvite(admin, { userId, delivery: "copy" });
      const url =
        copy.ok && copy.data.invite.state === "copy"
          ? copy.data.invite.url
          : "";
      expect(url).not.toBe("");

      const requestEmail = nextEmail("logs-request");
      const pending = await AccessRequestModel.create({
        name: "Requesting Person",
        email: requestEmail,
        company: "Other Co",
        country: "Taiwan",
        source: "form",
        status: "pending",
        consentAt: new Date(),
      });
      await approveAccessRequest(admin, {
        requestId: pending._id.toHexString(),
        name: "Requesting Person",
        company: "Other Co",
        country: "Taiwan",
        access: { kind: "months", months: 6 },
        delivery: "email",
      });
      await rejectAccessRequest(admin, {
        requestId: (
          await AccessRequestModel.create({
            name: "Rejected Person",
            email: nextEmail("logs-reject"),
            company: "Third Co",
            country: "Macau",
            source: "form",
            status: "pending",
            consentAt: new Date(),
          })
        )._id.toHexString(),
        sendEmail: true,
      });
      await authCall("/request-password-reset", {
        email,
        redirectTo: "/reset-password",
      });
      await Promise.all(harness.background);
      const token = new URL(url).searchParams.get("token") ?? "";
      await authCall("/reset-password", {
        token,
        newPassword: "short",
      });

      const all = lines.join("\n");
      expect(lines.length).toBeGreaterThan(0); // the failures were logged
      for (const secret of [
        email,
        requestEmail,
        "@example.com",
        "Loggable Person",
        "Requesting Person",
        "Rejected Person",
        "Secret Co",
        token,
        "reset-password?token",
        "/api/auth/reset-password/",
        "provider refused",
      ]) {
        expect(all, secret).not.toContain(secret);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("audit meta of every Phase 5 entry holds no address or name", async () => {
    const entries = await AuditLogModel.find({
      action: { $regex: /^(customer|access_request|cron)\./ },
    }).lean();
    expect(entries.length).toBeGreaterThan(0);
    const text = JSON.stringify(entries.map((e) => [e.meta, e.target]));
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/Person|Victim|Customer [a-z]/);
    expect(text).not.toMatch(/https?:\/\//);
  });
});

// ---------------------------------------------------------------------------
// Rule 8: operator injection on the service inputs
// ---------------------------------------------------------------------------

describe("operator injection in service inputs", () => {
  it("every id-taking service refuses non-string ids before any query", async () => {
    const injected = [{ $ne: null }, { $gt: "" }, ["a"], null, 42];
    for (const userId of injected) {
      for (const result of [
        await regenerateInvite(admin, { userId, delivery: "copy" }),
        await setCustomerAccess(admin, { userId, access: { kind: "none" } }),
        await setTemporaryPassword(admin, { userId }),
        await banCustomer(admin, { userId, reason: "x" }),
      ]) {
        expect(result.ok, JSON.stringify(userId)).toBe(false);
      }
      for (const requestId of [userId]) {
        expect((await deleteAccessRequest(admin, { requestId })).ok).toBe(
          false,
        );
      }
    }
    expect(
      await AuditLogModel.countDocuments({
        "target.id": { $not: /^[0-9a-f]{24}$/ },
        action: { $regex: /^(customer|access_request)\./ },
      }),
    ).toBe(0);
  });

  it("an unknown but well-formed id changes nothing", async () => {
    const userId = new Types.ObjectId().toHexString();
    const result = await regenerateInvite(admin, { userId, delivery: "copy" });
    expect(result.ok).toBe(false);
  });
});
