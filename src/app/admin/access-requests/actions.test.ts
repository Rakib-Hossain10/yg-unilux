// Behavioural tests for the access-request Server Actions (Phase 5 P7): a
// visitor, a customer, a banned admin and an admin on a temporary password
// reach no service; the admin's calls pass `{ id, headers }` and the raw input
// on; a refused actor (`denied`) is a 403; results reach the client without
// Date objects, with the copy-once link only in the "copy" state and the
// audit-failure message when the audit entry was not written.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIT_FAILED_MESSAGE } from "@/lib/admin/write-result";

import {
  ADMIN_USER_ID,
  REFUSED_CALLERS,
  sessionFor,
} from "../../../../test/helpers/admin-session";

import {
  approveAccessRequestAction,
  createManualAccessRequestAction,
  deleteAccessRequestAction,
  newInviteLinkAction,
  rejectAccessRequestAction,
} from "./actions";

const getSession = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => ({ headers: new Headers({ cookie: "x=1" }) }));
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
const services = vi.hoisted(() => ({
  approveAccessRequest: vi.fn(),
  rejectAccessRequest: vi.fn(),
  createManualAccessRequest: vi.fn(),
  deleteAccessRequest: vi.fn(),
}));
const customers = vi.hoisted(() => ({ regenerateInvite: vi.fn() }));

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
vi.mock("@/lib/admin/access-requests", () => services);
vi.mock("@/lib/admin/customers", () => customers);

const REQUEST_ID = "64b0000000000000000000aa";
const USER_ID = "64b0000000000000000000bb";
const APPROVE = {
  requestId: REQUEST_ID,
  name: "Ada Lovelace",
  company: "Engines Ltd",
  country: "Hong Kong",
  access: { kind: "months", months: 6 },
  delivery: "copy",
};
const REJECT = { requestId: REQUEST_ID, reason: "Not a trade buyer" };
const MANUAL = { name: "Ada Lovelace", email: "ada@example.com" };
const DELETE = { requestId: REQUEST_ID };
const LEAK = "https://example.test/reset-password?token=leak&invite=1";
const NEW_LINK = { userId: USER_ID, delivery: "email" };

const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["approve", () => approveAccessRequestAction(APPROVE)],
  ["reject", () => rejectAccessRequestAction(REJECT)],
  ["manual entry", () => createManualAccessRequestAction(MANUAL)],
  ["delete", () => deleteAccessRequestAction(DELETE)],
  ["new invite link", () => newInviteLinkAction(NEW_LINK)],
];

const ALL_SERVICES = [...Object.values(services), ...Object.values(customers)];

const refusedActor = {
  ok: false,
  errors: { formErrors: ["You are not allowed to do this."], fieldErrors: {} },
  tags: [],
  denied: "not_admin",
};

beforeEach(() => {
  getSession.mockReset();
  for (const fn of [...Object.values(nextCache), ...ALL_SERVICES]) {
    fn.mockReset();
  }
});

describe.each(REFUSED_CALLERS)("as %s", (_who, user, outcome) => {
  beforeEach(() => {
    getSession.mockResolvedValue(user === null ? null : sessionFor(user));
  });

  it.each(EVERY_ACTION)(
    "%s is refused before any service call",
    async (_name, call) => {
      await expect(call()).rejects.toThrow(outcome);
      for (const fn of ALL_SERVICES) expect(fn).not.toHaveBeenCalled();
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => getSession.mockResolvedValue(sessionFor()));

  it.each([
    [
      "approve",
      services.approveAccessRequest,
      APPROVE,
      approveAccessRequestAction,
    ],
    ["reject", services.rejectAccessRequest, REJECT, rejectAccessRequestAction],
    [
      "manual entry",
      services.createManualAccessRequest,
      MANUAL,
      createManualAccessRequestAction,
    ],
    ["delete", services.deleteAccessRequest, DELETE, deleteAccessRequestAction],
    [
      "new invite link",
      customers.regenerateInvite,
      NEW_LINK,
      newInviteLinkAction,
    ],
  ] as const)(
    "%s passes the session's id, the request headers and the raw input",
    async (_name, service, input, action) => {
      service.mockResolvedValue({
        ok: false,
        errors: { formErrors: ["nope"], fieldErrors: {} },
        tags: [],
      });
      await expect(
        (action as (i: unknown) => Promise<unknown>)(input),
      ).resolves.toEqual({
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

  it.each(EVERY_ACTION)(
    "%s answers a refused actor (denied) with a 403",
    async (_name, call) => {
      for (const fn of ALL_SERVICES) fn.mockResolvedValue(refusedActor);
      await expect(call()).rejects.toThrow("FORBIDDEN");
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );

  it("approve returns plain JSON, keeps the copy-once link and refreshes", async () => {
    services.approveAccessRequest.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        requestId: REQUEST_ID,
        userId: USER_ID,
        created: true,
        accessExpiresAt: new Date("2027-04-10T23:59:59.999Z"),
        invite: {
          state: "copy",
          url: "https://example.test/reset-password?token=t&invite=1",
          expiresAt: new Date("2026-10-13T10:00:00.000Z"),
        },
        notified: false,
        blocked: false,
        inviteWithheld: false,
        auditFailed: false,
      },
    });
    await expect(approveAccessRequestAction(APPROVE)).resolves.toEqual({
      ok: true,
      data: {
        userId: USER_ID,
        created: true,
        accessExpiresAt: "2027-04-10T23:59:59.999Z",
        invite: {
          state: "copy",
          url: "https://example.test/reset-password?token=t&invite=1",
          expiresAt: "2026-10-13T10:00:00.000Z",
        },
        notified: false,
        blocked: false,
        inviteWithheld: false,
        auditMessage: null,
      },
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });

  it("approve passes inviteWithheld, a null expiry and the audit failure on", async () => {
    services.approveAccessRequest.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        requestId: REQUEST_ID,
        userId: USER_ID,
        created: false,
        accessExpiresAt: null,
        invite: null,
        notified: true,
        blocked: true,
        inviteWithheld: true,
        auditFailed: true,
      },
    });
    const result = await approveAccessRequestAction(APPROVE);
    expect(result).toMatchObject({
      ok: true,
      data: {
        created: false,
        accessExpiresAt: null,
        invite: null,
        blocked: true,
        inviteWithheld: true,
        auditMessage: AUDIT_FAILED_MESSAGE,
      },
    });
  });

  it("approve never returns a URL for an emailed or failed invite", async () => {
    for (const invite of [
      // A stray `url` on any other state must never reach the browser.
      { state: "sent", expiresAt: new Date(), url: LEAK },
      { state: "send_failed", expiresAt: new Date(), url: LEAK },
      { state: "limited", retryAfterSeconds: 600, url: LEAK },
      { state: "busy", url: LEAK },
      { state: "failed", url: LEAK },
    ]) {
      services.approveAccessRequest.mockResolvedValue({
        ok: true,
        tags: [],
        data: {
          requestId: REQUEST_ID,
          userId: USER_ID,
          created: true,
          accessExpiresAt: null,
          invite,
          notified: false,
          blocked: false,
          inviteWithheld: false,
          auditFailed: false,
        },
      });
      const result = await approveAccessRequestAction(APPROVE);
      expect(JSON.stringify(result)).not.toMatch(/url|https?:/i);
    }
  });

  it("reject reports a saved write whose audit entry failed, and refreshes", async () => {
    services.rejectAccessRequest.mockResolvedValue({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: [],
    });
    await expect(rejectAccessRequestAction(REJECT)).resolves.toMatchObject({
      ok: false,
      saved: true,
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });

  it("reject returns whether the decline email went out", async () => {
    services.rejectAccessRequest.mockResolvedValue({
      ok: true,
      tags: [],
      data: { requestId: REQUEST_ID, emailSent: true },
    });
    await expect(rejectAccessRequestAction(REJECT)).resolves.toEqual({
      ok: true,
      data: { emailSent: true },
    });
  });

  it("the manual entry opens the new request", async () => {
    services.createManualAccessRequest.mockResolvedValue({
      ok: true,
      tags: [],
      data: { requestId: REQUEST_ID },
    });
    await expect(createManualAccessRequestAction(MANUAL)).rejects.toThrow(
      `REDIRECT /admin/access-requests/${REQUEST_ID}?notice=created`,
    );
  });

  it("delete shows the handled list", async () => {
    services.deleteAccessRequest.mockResolvedValue({
      ok: true,
      tags: [],
      data: { requestId: REQUEST_ID },
    });
    await expect(deleteAccessRequestAction(DELETE)).rejects.toThrow(
      "REDIRECT /admin/access-requests?tab=handled&notice=deleted",
    );
  });

  it("a new invite link comes back once for copying", async () => {
    customers.regenerateInvite.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        userId: USER_ID,
        invite: {
          state: "copy",
          url: "https://example.test/reset-password?token=u&invite=1",
          expiresAt: new Date("2026-10-13T10:00:00.000Z"),
        },
        auditFailed: false,
      },
    });
    await expect(newInviteLinkAction(NEW_LINK)).resolves.toEqual({
      ok: true,
      data: {
        invite: {
          state: "copy",
          url: "https://example.test/reset-password?token=u&invite=1",
          expiresAt: "2026-10-13T10:00:00.000Z",
        },
        auditMessage: null,
      },
    });
  });

  it("a new invite link does not refresh (the request page shows no invite state)", async () => {
    customers.regenerateInvite.mockResolvedValue({
      ok: true,
      tags: [],
      data: {
        userId: USER_ID,
        invite: { state: "sent", expiresAt: new Date() },
        auditFailed: false,
      },
    });
    await newInviteLinkAction(NEW_LINK);
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("a manual entry saved without its audit entry refreshes and reports saved", async () => {
    services.createManualAccessRequest.mockResolvedValue({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: [],
    });
    await expect(
      createManualAccessRequestAction(MANUAL),
    ).resolves.toMatchObject({
      ok: false,
      saved: true,
    });
    expect(nextCache.refresh).toHaveBeenCalledTimes(1);
  });

  it("a delete saved without its audit entry does not refresh (the page would 404)", async () => {
    services.deleteAccessRequest.mockResolvedValue({
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags: [],
    });
    await expect(deleteAccessRequestAction(DELETE)).resolves.toMatchObject({
      ok: false,
      saved: true,
    });
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });
});
