// Tests for src/lib/permissions.ts: the access matrix (admin, customer,
// banned, expired, temporary password, no role, signed out) and the request
// guards' redirects, 403s and JSON answers.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AccessUser,
  canSeeRestricted,
  checkDatasheetAccess,
  isActiveAdmin,
  isBanned,
  loginPathFor,
  requireAdmin,
  requireSignedIn,
  requireAdminForRoute,
  requireCustomerAccess,
  viewerCanSeeRestricted,
} from "./permissions";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// redirect() and forbidden() throw in Next; these stand-ins throw a
// recognisable error so the tests can see which one ran.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));

const NOW = new Date("2026-10-03T12:00:00Z");
const PAST = new Date("2026-10-01T00:00:00Z");
const FUTURE = new Date("2027-01-01T00:00:00Z");

const user = (fields: Partial<AccessUser> = {}): AccessUser => ({
  id: "u1",
  role: "customer",
  banned: false,
  banExpires: null,
  mustChangePassword: false,
  accessExpiresAt: null,
  ...fields,
});

const signedInAs = (fields: Partial<AccessUser>) =>
  getSession.mockResolvedValue({ session: { id: "s1" }, user: user(fields) });

beforeEach(() => {
  getSession.mockReset();
});

describe("isBanned", () => {
  it("is false when not banned", () => {
    expect(isBanned(user(), NOW)).toBe(false);
  });
  it("is true for a ban with no end", () => {
    expect(isBanned(user({ banned: true }), NOW)).toBe(true);
  });
  it("is true until a timed ban ends, false after", () => {
    expect(isBanned(user({ banned: true, banExpires: FUTURE }), NOW)).toBe(
      true,
    );
    expect(isBanned(user({ banned: true, banExpires: PAST }), NOW)).toBe(false);
  });
  it("fails closed on an unreadable ban end", () => {
    expect(isBanned(user({ banned: true, banExpires: "nonsense" }), NOW)).toBe(
      true,
    );
  });
});

describe("isActiveAdmin", () => {
  it("accepts an admin, including a comma-joined role list", () => {
    expect(isActiveAdmin(user({ role: "admin" }), NOW)).toBe(true);
    expect(isActiveAdmin(user({ role: "customer,admin" }), NOW)).toBe(true);
  });
  it("rejects customers, missing roles and banned admins", () => {
    expect(isActiveAdmin(user(), NOW)).toBe(false);
    expect(isActiveAdmin(user({ role: null }), NOW)).toBe(false);
    expect(isActiveAdmin(user({ role: "administrator" }), NOW)).toBe(false);
    expect(isActiveAdmin(user({ role: "admin", banned: true }), NOW)).toBe(
      false,
    );
  });
});

describe("checkDatasheetAccess", () => {
  const cases: [string, AccessUser | null, string][] = [
    ["signed out", null, "signed-out"],
    ["no role", user({ role: null }), "not-allowed"],
    ["unknown role", user({ role: "staff" }), "not-allowed"],
    ["banned customer", user({ banned: true }), "banned"],
    ["banned admin", user({ role: "admin", banned: true }), "banned"],
    [
      "customer on a temporary password",
      user({ mustChangePassword: true }),
      "must-change-password",
    ],
    [
      "admin on a temporary password",
      user({ role: "admin", mustChangePassword: true }),
      "must-change-password",
    ],
    ["expired customer", user({ accessExpiresAt: PAST }), "expired"],
    ["customer expiring right now", user({ accessExpiresAt: NOW }), "expired"],
    [
      "customer with an unreadable expiry",
      user({ accessExpiresAt: "not a date" }),
      "expired",
    ],
  ];

  it.each(cases)("refuses a %s", (_label, who, reason) => {
    expect(checkDatasheetAccess(who, NOW)).toEqual({ ok: false, reason });
    expect(canSeeRestricted(who, NOW)).toBe(false);
  });

  const allowed: [string, AccessUser][] = [
    ["customer with no expiry", user()],
    ["customer before expiry", user({ accessExpiresAt: FUTURE })],
    [
      "customer with expiry as a string",
      user({ accessExpiresAt: FUTURE.toISOString() }),
    ],
    [
      "customer after a timed ban ended",
      user({ banned: true, banExpires: PAST }),
    ],
    ["admin", user({ role: "admin" })],
    [
      "admin with a past expiry date",
      user({ role: "admin", accessExpiresAt: PAST }),
    ],
  ];

  it.each(allowed)("allows a %s", (_label, who) => {
    expect(checkDatasheetAccess(who, NOW)).toEqual({ ok: true, user: who });
    expect(canSeeRestricted(who, NOW)).toBe(true);
  });

  it("fails closed when mustChangePassword is missing or not a boolean", () => {
    const missing = user();
    delete missing.mustChangePassword;
    expect(checkDatasheetAccess(missing, NOW)).toEqual({
      ok: false,
      reason: "must-change-password",
    });
    const odd = user({ mustChangePassword: "no" as unknown as boolean });
    expect(canSeeRestricted(odd, NOW)).toBe(false);
    expect(canSeeRestricted(user({ mustChangePassword: null }), NOW)).toBe(
      false,
    );
  });

  it("refuses an undefined user", () => {
    expect(canSeeRestricted(undefined, NOW)).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("redirects a signed-out visitor to the login page", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toThrow("REDIRECT /login");
  });

  it("answers 403 to a customer, even on a temporary password", async () => {
    signedInAs({});
    await expect(requireAdmin()).rejects.toThrow("FORBIDDEN");
    signedInAs({ mustChangePassword: true });
    await expect(requireAdmin()).rejects.toThrow("FORBIDDEN");
  });

  it("answers 403 to a banned admin", async () => {
    signedInAs({ role: "admin", banned: true });
    await expect(requireAdmin()).rejects.toThrow("FORBIDDEN");
  });

  it("sends an admin on a temporary password to change it", async () => {
    signedInAs({ role: "admin", mustChangePassword: true });
    await expect(requireAdmin()).rejects.toThrow("REDIRECT /change-password");
  });

  it("returns the viewer for an active admin", async () => {
    signedInAs({ role: "admin" });
    const viewer = await requireAdmin();
    expect(viewer.user.role).toBe("admin");
  });

  it("lets a database failure through instead of allowing or signing out", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    await expect(requireAdmin()).rejects.toThrow("db down");
  });
});

describe("requireSignedIn", () => {
  it("sends a signed-out visitor to the login page with a safe next", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireSignedIn("/my-downloads")).rejects.toThrow(
      "REDIRECT /login?next=%2Fmy-downloads",
    );
  });

  it("drops an unsafe next and sends plain /login", async () => {
    getSession.mockResolvedValue(null);
    await expect(requireSignedIn("//evil.example")).rejects.toThrow(
      /^REDIRECT \/login$/,
    );
    await expect(requireSignedIn()).rejects.toThrow(/^REDIRECT \/login$/);
  });

  it("returns a temporary-password user without redirecting (callers decide)", async () => {
    signedInAs({ mustChangePassword: true });
    const viewer = await requireSignedIn("/change-password");
    expect(viewer.user.mustChangePassword).toBe(true);
  });

  it("returns banned and expired users too (no access check here)", async () => {
    signedInAs({ banned: true, accessExpiresAt: PAST });
    expect((await requireSignedIn()).user.banned).toBe(true);
  });

  it("lets a database failure through", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    await expect(requireSignedIn()).rejects.toThrow("db down");
  });
});

describe("loginPathFor", () => {
  it("keeps a query in next, encoded", () => {
    expect(loginPathFor("/product/arc-ar-013a?model=AR-013A2")).toBe(
      "/login?next=%2Fproduct%2Farc-ar-013a%3Fmodel%3DAR-013A2",
    );
  });

  it("falls back to /login for null, empty or unsafe values", () => {
    expect(loginPathFor(null)).toBe("/login");
    expect(loginPathFor("")).toBe("/login");
    expect(loginPathFor("https://evil.example/")).toBe("/login");
  });
});

describe("requireAdminForRoute", () => {
  it("answers a private JSON 401 when signed out", async () => {
    getSession.mockResolvedValue(null);
    const check = await requireAdminForRoute();
    if (check.ok) throw new Error("expected a refusal");
    expect(check.response.status).toBe(401);
    expect(check.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
    expect(await check.response.json()).toEqual({
      message: "Sign in required.",
    });
  });

  it.each([
    ["a customer", {}],
    ["a banned admin", { role: "admin", banned: true }],
    [
      "an admin on a temporary password",
      { role: "admin", mustChangePassword: true },
    ],
  ])("answers 403 to %s", async (_label, fields) => {
    signedInAs(fields);
    const check = await requireAdminForRoute();
    if (check.ok) throw new Error("expected a refusal");
    expect(check.response.status).toBe(403);
    expect(check.response.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("returns the viewer for an active admin", async () => {
    signedInAs({ role: "admin" });
    const check = await requireAdminForRoute();
    expect(check.ok).toBe(true);
  });
});

describe("requireCustomerAccess and viewerCanSeeRestricted", () => {
  it("refuse a signed-out visitor", async () => {
    getSession.mockResolvedValue(null);
    expect(await requireCustomerAccess()).toEqual({
      ok: false,
      reason: "signed-out",
    });
    expect(await viewerCanSeeRestricted()).toBe(false);
  });

  it("refuse an expired customer with the expired reason", async () => {
    signedInAs({ accessExpiresAt: new Date(Date.now() - 1000) });
    expect(await requireCustomerAccess()).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await viewerCanSeeRestricted()).toBe(false);
  });

  it("allow an active customer", async () => {
    signedInAs({ accessExpiresAt: new Date(Date.now() + 60_000) });
    expect((await requireCustomerAccess()).ok).toBe(true);
    expect(await viewerCanSeeRestricted()).toBe(true);
  });
});
