// Behavioural tests for the customer Server Actions (Phase 5 P8): a visitor,
// a customer, a banned admin and an admin on a temporary password reach no
// service; the admin's calls pass `{ id, headers }` and the raw input on; a
// refused actor (`denied`) is a 403; results reach the client as plain JSON,
// with the copy-once link only in the "copy" state, the temporary password
// only in its own answer, and the audit-failure message when the entry was
// not written.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIT_FAILED_MESSAGE } from "@/lib/admin/write-result";

import {
  ADMIN_USER_ID,
  REFUSED_CALLERS,
  sessionFor,
} from "../../../../test/helpers/admin-session";

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
} from "./actions";

const getSession = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => ({ headers: new Headers({ cookie: "x=1" }) }));
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
const services = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  updateCustomerProfile: vi.fn(),
  setCustomerAccess: vi.fn(),
  endCustomerAccess: vi.fn(),
  banCustomer: vi.fn(),
  unbanCustomer: vi.fn(),
  revokeCustomerSessions: vi.fn(),
  sendCustomerResetLink: vi.fn(),
  setTemporaryPassword: vi.fn(),
  regenerateInvite: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => request.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));
vi.mock("next/cache", () => nextCache);
vi.mock("@/lib/admin/customers", () => services);

const USER_ID = "64b0000000000000000000bb";
const ID = { userId: USER_ID };
const CREATE = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "",
  country: "",
  access: { kind: "months", months: 6 },
  delivery: "copy",
};
const PROFILE = { userId: USER_ID, name: "Ada", company: "", country: "" };
const ACCESS = { userId: USER_ID, access: { kind: "none" }, notify: true };
const BAN = { userId: USER_ID, reason: "Left the company" };
const INVITE = { userId: USER_ID, delivery: "copy" };
const LEAK = "https://example.test/reset-password?token=leak&invite=1";

type Action = (input: unknown) => Promise<unknown>;
const CASES: [string, Action, ReturnType<typeof vi.fn>, unknown][] = [
  ["create", createCustomerAction, services.createCustomer, CREATE],
  [
    "profile",
    updateCustomerProfileAction,
    services.updateCustomerProfile,
    PROFILE,
  ],
  ["access", setCustomerAccessAction, services.setCustomerAccess, ACCESS],
  ["end access", endAccessAction, services.endCustomerAccess, ID],
  ["block", banCustomerAction, services.banCustomer, BAN],
  ["unblock", unbanCustomerAction, services.unbanCustomer, ID],
  [
    "end sessions",
    revokeCustomerSessionsAction,
    services.revokeCustomerSessions,
    ID,
  ],
  [
    "reset link",
    sendCustomerResetLinkAction,
    services.sendCustomerResetLink,
    ID,
  ],
  [
    "temporary password",
    setTemporaryPasswordAction,
    services.setTemporaryPassword,
    ID,
  ],
  ["new invite", newCustomerInviteAction, services.regenerateInvite, INVITE],
];

const ALL_SERVICES = Object.values(services);

beforeEach(() => {
  getSession.mockReset();
  for (const fn of [...Object.values(nextCache), ...ALL_SERVICES]) {
    fn.mockReset();
  }
});

it("covers every exported action", async () => {
  const exported = Object.keys(await import("./actions")).sort();
  expect(exported).toEqual(
    [
      "banCustomerAction",
      "createCustomerAction",
      "endAccessAction",
      "newCustomerInviteAction",
      "revokeCustomerSessionsAction",
      "sendCustomerResetLinkAction",
      "setCustomerAccessAction",
      "setTemporaryPasswordAction",
      "unbanCustomerAction",
      "updateCustomerProfileAction",
    ].sort(),
  );
  expect(CASES).toHaveLength(exported.length);
});

describe.each(REFUSED_CALLERS)("as %s", (_who, user, outcome) => {
  beforeEach(() => {
    getSession.mockResolvedValue(user === null ? null : sessionFor(user));
  });

  it.each(CASES)(
    "%s is refused before any service call",
    async (_name, action, _service, input) => {
      await expect(action(input)).rejects.toThrow(outcome);
      for (const fn of ALL_SERVICES) expect(fn).not.toHaveBeenCalled();
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => getSession.mockResolvedValue(sessionFor()));

  it.each(CASES)(
    "%s passes the session's id, the request headers and the raw input",
    async (_name, action, service, input) => {
      service.mockResolvedValue({
        ok: false,
        errors: { formErrors: ["nope"], fieldErrors: {} },
        tags: [],
      });
      await expect(action(input)).resolves.toEqual({
        ok: false,
        errors: { formErrors: ["nope"], fieldErrors: {} },
        saved: false,
      });
      expect(service).toHaveBeenCalledTimes(1);
      const [actor, passed] = service.mock.calls[0] as [
        { id: string; headers: Headers },
        unknown,
      ];
      expect(actor.id).toBe(ADMIN_USER_ID);
      expect(actor.headers).toBe(request.headers);
      expect(passed).toBe(input);
      // Nothing was written, so nothing is refreshed.
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );

  it.each(CASES)(
    "%s answers a refused actor (denied) with a 403",
    async (_name, action, service, input) => {
      service.mockResolvedValue({
        ok: false,
        errors: {
          formErrors: ["You are not allowed to do this."],
          fieldErrors: {},
        },
        tags: [],
        denied: "not_admin",
      });
      await expect(action(input)).rejects.toThrow("FORBIDDEN");
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );

  it("create returns plain JSON with the copy-once link and does not redirect", async () => {
    services.createCustomer.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        userId: USER_ID,
        accessExpiresAt: new Date("2027-04-10T15:59:59.999Z"),
        invite: {
          state: "copy",
          url: "https://example.test/reset-password?token=t&invite=1",
          expiresAt: new Date("2026-10-13T10:00:00.000Z"),
        },
        auditFailed: false,
      },
    });
    await expect(createCustomerAction(CREATE)).resolves.toEqual({
      ok: true,
      data: {
        userId: USER_ID,
        accessExpiresAt: "2027-04-10T15:59:59.999Z",
        invite: {
          state: "copy",
          url: "https://example.test/reset-password?token=t&invite=1",
          expiresAt: "2026-10-13T10:00:00.000Z",
        },
        auditMessage: null,
      },
    });
  });

  it("create and new invite never return a URL for an emailed or failed invite", async () => {
    for (const invite of [
      { state: "sent", expiresAt: new Date(), url: LEAK },
      { state: "send_failed", expiresAt: new Date(), url: LEAK },
      { state: "limited", retryAfterSeconds: 600, url: LEAK },
      { state: "busy", url: LEAK },
      { state: "failed", url: LEAK },
    ]) {
      services.createCustomer.mockResolvedValue({
        ok: true,
        tags: [],
        data: {
          userId: USER_ID,
          accessExpiresAt: null,
          invite,
          auditFailed: false,
        },
      });
      services.regenerateInvite.mockResolvedValue({
        ok: true,
        tags: [],
        data: { userId: USER_ID, invite, auditFailed: false },
      });
      expect(JSON.stringify(await createCustomerAction(CREATE))).not.toMatch(
        /url|https?:/i,
      );
      expect(JSON.stringify(await newCustomerInviteAction(INVITE))).not.toMatch(
        /url|https?:/i,
      );
    }
  });

  it("a new invite link passes the audit failure on and does not refresh", async () => {
    services.regenerateInvite.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        userId: USER_ID,
        invite: { state: "sent", expiresAt: new Date("2026-10-13T10:00:00Z") },
        auditFailed: true,
      },
    });
    await expect(newCustomerInviteAction(INVITE)).resolves.toEqual({
      ok: true,
      data: {
        invite: { state: "sent", expiresAt: "2026-10-13T10:00:00.000Z" },
        auditMessage: AUDIT_FAILED_MESSAGE,
      },
    });
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("the temporary password comes back once and the page refreshes", async () => {
    services.setTemporaryPassword.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        userId: USER_ID,
        password: "Abcdefgh23456789",
        auditFailed: false,
      },
    });
    await expect(setTemporaryPasswordAction(ID)).resolves.toEqual({
      ok: true,
      data: { password: "Abcdefgh23456789", auditMessage: null },
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });

  it("access returns the new end as an ISO string and refreshes", async () => {
    services.setCustomerAccess.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        accessExpiresAt: new Date("2027-01-31T15:59:59.999Z"),
        notified: true,
      },
    });
    await expect(setCustomerAccessAction(ACCESS)).resolves.toEqual({
      ok: true,
      data: { accessExpiresAt: "2027-01-31T15:59:59.999Z", notified: true },
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });

  it("end access returns the end as an ISO string and refreshes", async () => {
    services.endCustomerAccess.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        accessExpiresAt: new Date("2026-10-10T06:30:00.000Z"),
        alreadyEnded: false,
      },
    });
    await expect(endAccessAction(ID)).resolves.toEqual({
      ok: true,
      data: {
        accessExpiresAt: "2026-10-10T06:30:00.000Z",
        alreadyEnded: false,
      },
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });

  it("end access passes an already-ended answer on", async () => {
    services.endCustomerAccess.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        accessExpiresAt: new Date("2026-01-31T15:59:59.999Z"),
        alreadyEnded: true,
      },
    });
    await expect(endAccessAction(ID)).resolves.toEqual({
      ok: true,
      data: { accessExpiresAt: "2026-01-31T15:59:59.999Z", alreadyEnded: true },
    });
  });

  it("end access saved without its audit entry shows the audit message", async () => {
    services.endCustomerAccess.mockResolvedValue({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: [],
    });
    await expect(endAccessAction(ID)).resolves.toEqual({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      saved: true,
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "profile",
      updateCustomerProfileAction,
      services.updateCustomerProfile,
      PROFILE,
    ],
    ["block", banCustomerAction, services.banCustomer, BAN],
    ["unblock", unbanCustomerAction, services.unbanCustomer, ID],
    [
      "end sessions",
      revokeCustomerSessionsAction,
      services.revokeCustomerSessions,
      ID,
    ],
    [
      "reset link",
      sendCustomerResetLinkAction,
      services.sendCustomerResetLink,
      ID,
    ],
  ] as const)(
    "%s refreshes on success",
    async (_name, action, service, input) => {
      service.mockResolvedValue({
        ok: true,
        tags: [],
        data: { userId: USER_ID },
      });
      await expect(action(input)).resolves.toEqual({ ok: true });
      expect(nextCache.refresh).toHaveBeenCalledTimes(1);
    },
  );

  it("a write saved without its audit entry reports saved and refreshes", async () => {
    services.banCustomer.mockResolvedValue({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: [],
    });
    await expect(banCustomerAction(BAN)).resolves.toMatchObject({
      ok: false,
      saved: true,
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });
});
