// Tests for the /my-downloads access line: admin, active until a date, no
// expiry, expired (also at the exact instant), temporary password, paused by
// a ban, no role; and the UTC date formats.

import { describe, expect, it } from "vitest";

import { accessStatus, formatDay, formatMoment } from "./access-status";

const now = new Date("2026-10-09T12:00:00.000Z");
const endOfDay = new Date("2027-03-31T23:59:59.999Z");
const customer = {
  id: "u1",
  role: "customer",
  mustChangePassword: false,
  banned: false,
};

describe("accessStatus", () => {
  it("admin has no expiry", () => {
    expect(
      accessStatus({ ...customer, role: "admin", accessExpiresAt: now }, now),
    ).toEqual({ kind: "admin" });
  });

  it("active until the expiry date, or open without one", () => {
    expect(
      accessStatus({ ...customer, accessExpiresAt: endOfDay }, now),
    ).toEqual({ kind: "active", until: endOfDay });
    expect(accessStatus({ ...customer, accessExpiresAt: null }, now)).toEqual({
      kind: "open",
    });
  });

  it("expired from the expiry instant on", () => {
    expect(accessStatus({ ...customer, accessExpiresAt: now }, now)).toEqual({
      kind: "expired",
      since: now,
    });
    // An unreadable date fails closed, without a date to show.
    expect(
      accessStatus({ ...customer, accessExpiresAt: "not a date" }, now),
    ).toEqual({ kind: "expired", since: null });
  });

  it("temporary password, ban and no role", () => {
    expect(
      accessStatus({ ...customer, mustChangePassword: true }, now),
    ).toEqual({ kind: "password" });
    expect(accessStatus({ ...customer, banned: true }, now)).toEqual({
      kind: "paused",
    });
    expect(accessStatus({ ...customer, role: "" }, now)).toEqual({
      kind: "none",
    });
  });
});

describe("date formats", () => {
  it("are UTC", () => {
    expect(formatDay(endOfDay)).toBe("31 March 2027");
    expect(formatMoment(new Date("2026-10-09T23:30:00.000Z"))).toBe(
      "9 Oct 2026, 23:30 UTC",
    );
  });
});
