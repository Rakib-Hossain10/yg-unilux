// Tests for the access-expiry math (plan Q5, ADR 0070): presets counted from
// the later of today and the current end, end of the day in the app zone
// (China time: 15:59:59.999Z), month-end clamping, the 16:00Z day switch,
// custom days (real calendar days only) and no expiry.

import { describe, expect, it } from "vitest";

import { computeAccessExpiry, parseAccessDay } from "./access-expiry";

const at = (iso: string) => new Date(iso);
const expiry = (...args: Parameters<typeof computeAccessExpiry>) =>
  computeAccessExpiry(...args)?.toISOString() ?? null;

describe("parseAccessDay", () => {
  it("is the start of that day in China time", () => {
    expect(parseAccessDay("2028-02-29")?.toISOString()).toBe(
      "2028-02-28T16:00:00.000Z",
    );
  });

  it("accepts real calendar days within the bounds only", () => {
    expect(parseAccessDay("2000-01-01")).not.toBeNull();
    expect(parseAccessDay("2100-12-31")).not.toBeNull();
    for (const bad of [
      "2026-02-29",
      "2026-02-30",
      "2026-13-01",
      "2026-1-01",
      "26-01-01",
      "2026-01-01T00:00",
      "1999-12-31",
      "2101-01-01",
      "",
    ]) {
      expect(parseAccessDay(bad), bad).toBeNull();
    }
  });
});

describe("computeAccessExpiry", () => {
  // 15:30Z = 23:30 on 9 Oct in China.
  const now = at("2026-10-09T15:30:00.000Z");

  it("months from today for a new account: end of that China day", () => {
    expect(expiry({ kind: "months", months: 3 }, { now })).toBe(
      "2027-01-09T15:59:59.999Z",
    );
    expect(expiry({ kind: "months", months: 6 }, { now })).toBe(
      "2027-04-09T15:59:59.999Z",
    );
    expect(expiry({ kind: "months", months: 12 }, { now })).toBe(
      "2027-10-09T15:59:59.999Z",
    );
  });

  it("counts from the China day, which starts at 16:00Z", () => {
    // 16:30Z on 9 Oct is already 10 Oct in China.
    expect(
      expiry(
        { kind: "months", months: 3 },
        { now: at("2026-10-09T16:30:00Z") },
      ),
    ).toBe("2027-01-10T15:59:59.999Z");
    expect(
      expiry(
        { kind: "months", months: 3 },
        { now: at("2026-10-09T15:59:59.999Z") },
      ),
    ).toBe("2027-01-09T15:59:59.999Z");
  });

  it("clamps to the last day of a shorter month in China time", () => {
    // 17:00Z on 29 Nov is 01:00 on 30 Nov in China (the UTC day lags).
    expect(
      expiry(
        { kind: "months", months: 3 },
        { now: at("2027-11-29T17:00:00Z") },
      ),
    ).toBe("2028-02-29T15:59:59.999Z"); // 30 Nov China + 3 = 29 Feb (leap)
    expect(
      expiry(
        { kind: "months", months: 6 },
        { now: at("2026-08-30T16:00:00Z") },
      ),
    ).toBe("2027-02-28T15:59:59.999Z"); // 31 Aug China + 6 = 28 Feb
  });

  it("extends from the current end when it is still ahead", () => {
    const current = at("2026-12-31T15:59:59.999Z");
    expect(expiry({ kind: "months", months: 3 }, { now, current })).toBe(
      "2027-03-31T15:59:59.999Z",
    );
  });

  it("extends from today when the current end has passed", () => {
    const current = at("2026-01-15T15:59:59.999Z");
    expect(expiry({ kind: "months", months: 6 }, { now, current })).toBe(
      "2027-04-09T15:59:59.999Z",
    );
  });

  it("an end equal to now counts as passed (counted from now)", () => {
    expect(
      expiry({ kind: "months", months: 3 }, { now, current: new Date(now) }),
    ).toBe("2027-01-09T15:59:59.999Z");
  });

  it("no current expiry (null) counts from today", () => {
    expect(expiry({ kind: "months", months: 12 }, { now, current: null })).toBe(
      "2027-10-09T15:59:59.999Z",
    );
  });

  it("a custom day ends at its last China-time millisecond, even in the past", () => {
    expect(
      expiry(
        { kind: "date", date: "2026-12-31" },
        { now, current: at("2030-01-01T00:00:00Z") },
      ),
    ).toBe("2026-12-31T15:59:59.999Z");
    expect(expiry({ kind: "date", date: "2026-10-01" }, { now })).toBe(
      "2026-10-01T15:59:59.999Z",
    );
  });

  it("none is null; an invalid or out-of-bounds custom day throws", () => {
    expect(computeAccessExpiry({ kind: "none" }, { now })).toBeNull();
    for (const date of ["2026-02-30", "1999-12-31", "2101-01-01", "x"]) {
      expect(() =>
        computeAccessExpiry({ kind: "date", date }, { now }),
      ).toThrow(RangeError);
    }
  });
});
