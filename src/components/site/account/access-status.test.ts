// Tests for the /my-downloads access line: admin, active until a date, no
// expiry, expired (also at the exact instant), temporary password, paused by
// a ban, no role; and the China-time date formats.

import { describe, expect, it } from "vitest";

import {
  MOMENT_ZONE_LABEL,
  accessStatus,
  formatDay,
  formatMoment,
  formatMomentShort,
} from "./access-status";

const now = new Date("2026-10-09T12:00:00.000Z");
// The end of 31 Mar 2027 in China time.
const endOfDay = new Date("2027-03-31T15:59:59.999Z");
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
  it("are China time, like the admin screens and emails", () => {
    expect(formatDay(endOfDay)).toBe("31 Mar 2027");
    // One ms later is already 1 Apr in China.
    expect(formatDay(new Date(endOfDay.getTime() + 1))).toBe("1 Apr 2027");
    expect(formatMoment(new Date("2026-10-09T23:30:00.000Z"))).toBe(
      "10 Oct 2026, 07:30 (China time)",
    );
  });

  it("has a short moment for lists whose header names the zone once", () => {
    const moment = new Date("2026-09-04T09:00:00.000Z");
    expect(formatMomentShort(moment)).toBe("4 Sep 2026, 17:00");
    expect(MOMENT_ZONE_LABEL).toBe("China time");
    // The long form is the short one plus the label, nothing else changes.
    expect(formatMoment(moment)).toBe(
      `${formatMomentShort(moment)} (${MOMENT_ZONE_LABEL})`,
    );
  });
});
