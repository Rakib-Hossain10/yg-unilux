// Behavioural tests for the settings Server Actions (T15): a visitor, a
// customer, a banned admin and an admin on a temporary password reach no
// service; the admin's calls pass the session's id and the input on,
// revalidate on both branches and refresh when something was written.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_USER_ID,
  REFUSED_CALLERS,
  sessionFor,
} from "../../../../test/helpers/admin-session";

import {
  saveColumnVisibilityAction,
  saveCompanyEmailAction,
  saveWhatsappNumberAction,
} from "./actions";

const getSession = vi.hoisted(() => vi.fn());
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
const services = vi.hoisted(() => ({
  saveColumnVisibility: vi.fn(),
  saveWhatsappNumber: vi.fn(),
  saveCompanyEmail: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));
vi.mock("next/cache", () => nextCache);
vi.mock("@/lib/admin/settings", () => services);

const COLUMNS = { driver: "public", lens: "restricted" };

const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["column visibility", () => saveColumnVisibilityAction(COLUMNS)],
  ["whatsapp number", () => saveWhatsappNumberAction("+852 1234 5678")],
  ["company email", () => saveCompanyEmailAction("info@example.com")],
];

beforeEach(() => {
  getSession.mockReset();
  for (const fn of [...Object.values(nextCache), ...Object.values(services)]) {
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
      for (const fn of Object.values(services)) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(nextCache.updateTag).not.toHaveBeenCalled();
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => getSession.mockResolvedValue(sessionFor()));

  it("column visibility passes the id and input, revalidates and refreshes", async () => {
    services.saveColumnVisibility.mockResolvedValue({
      ok: true,
      data: {},
      tags: ["settings:columns", "products"],
    });
    expect(await saveColumnVisibilityAction(COLUMNS)).toEqual({ ok: true });
    expect(services.saveColumnVisibility).toHaveBeenCalledWith(
      ADMIN_USER_ID,
      COLUMNS,
    );
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("a cleanup failure after a saved change reports saved: true and still revalidates", async () => {
    const errors = { formErrors: ["Save again to retry."], fieldErrors: {} };
    services.saveColumnVisibility.mockResolvedValue({
      ok: false,
      errors,
      tags: ["settings:columns", "products"],
    });
    expect(await saveColumnVisibilityAction(COLUMNS)).toEqual({
      ok: false,
      errors,
      saved: true,
    });
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("invalid columns return the errors, nothing saved or refreshed", async () => {
    const errors = { formErrors: [], fieldErrors: { driver: ["Choose"] } };
    services.saveColumnVisibility.mockResolvedValue({
      ok: false,
      errors,
      tags: [],
    });
    expect(await saveColumnVisibilityAction({ driver: "x" })).toEqual({
      ok: false,
      errors,
      saved: false,
    });
    expect(nextCache.updateTag).not.toHaveBeenCalled();
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["whatsapp", saveWhatsappNumberAction, services.saveWhatsappNumber, "+852"],
    ["email", saveCompanyEmailAction, services.saveCompanyEmail, "a@b.co"],
  ] as const)(
    "%s passes the input on; no tags means no refresh",
    async (_name, action, service, input) => {
      service.mockResolvedValue({ ok: true, data: {}, tags: [] });
      expect(await action(input)).toEqual({ ok: true });
      expect(service).toHaveBeenCalledWith(ADMIN_USER_ID, input);
      expect(nextCache.updateTag).not.toHaveBeenCalled();
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );

  it("a bad number comes back as a field error, saved: false", async () => {
    const errors = { formErrors: ["Use digits only"], fieldErrors: {} };
    services.saveWhatsappNumber.mockResolvedValue({
      ok: false,
      errors,
      tags: [],
    });
    expect(await saveWhatsappNumberAction("abc")).toEqual({
      ok: false,
      errors,
      saved: false,
    });
  });
});
