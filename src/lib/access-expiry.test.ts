// Tests for the access-expiry math (plan Q5, ADR 0070): presets counted from
// the later of today and the current end, end of the UTC day, month-end
// clamping, custom days (real calendar days only) and no expiry.

import { describe, expect, it } from "vitest";

import {
  addUtcMonths,
  computeAccessExpiry,
  endOfUtcDay,
  parseAccessDay,
} from "./access-expiry";

const at = (iso: string) => new Date(iso);

describe("endOfUtcDay", () => {
  it("is 23:59:59.999 UTC of the same UTC day", () => {
    expect(endOfUtcDay(at("2026-10-09T00:00:00.000Z")).toISOString()).toBe(
      "2026-10-09T23:59:59.999Z",
    );
    expect(endOfUtcDay(at("2026-10-09T23:59:59.999Z")).toISOString()).toBe(
      "2026-10-09T23:59:59.999Z",
    );
  });
});

describe("addUtcMonths", () => {
  it("clamps to the last day of a shorter month", () => {
    expect(addUtcMonths(at("2026-01-31T10:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T10:00:00.000Z",
    );
    expect(addUtcMonths(at("2027-11-30T10:00:00Z"), 3).toISOString()).toBe(
      "2028-02-29T10:00:00.000Z",
    );
    expect(addUtcMonths(at("2026-08-31T00:00:00Z"), 6).toISOString()).toBe(
      "2027-02-28T00:00:00.000Z",
    );
  });

  it("crosses years", () => {
    expect(addUtcMonths(at("2026-10-09T12:00:00Z"), 12).toISOString()).toBe(
      "2027-10-09T12:00:00.000Z",
    );
  });
});

describe("parseAccessDay", () => {
  it("accepts real calendar days only", () => {
    expect(parseAccessDay("2028-02-29")?.toISOString()).toBe(
      "2028-02-29T00:00:00.000Z",
    );
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
  const now = at("2026-10-09T15:30:00.000Z");

  it("months from today for a new account: end of that UTC day", () => {
    expect(
      computeAccessExpiry(
        { kind: "months", months: 3 },
        { now },
      )?.toISOString(),
    ).toBe("2027-01-09T23:59:59.999Z");
    expect(
      computeAccessExpiry(
        { kind: "months", months: 6 },
        { now },
      )?.toISOString(),
    ).toBe("2027-04-09T23:59:59.999Z");
    expect(
      computeAccessExpiry(
        { kind: "months", months: 12 },
        { now },
      )?.toISOString(),
    ).toBe("2027-10-09T23:59:59.999Z");
  });

  it("extends from the current end when it is still ahead", () => {
    const current = at("2026-12-31T23:59:59.999Z");
    expect(
      computeAccessExpiry(
        { kind: "months", months: 3 },
        { now, current },
      )?.toISOString(),
    ).toBe("2027-03-31T23:59:59.999Z");
  });

  it("extends from today when the current end has passed", () => {
    const current = at("2026-01-15T23:59:59.999Z");
    expect(
      computeAccessExpiry(
        { kind: "months", months: 6 },
        { now, current },
      )?.toISOString(),
    ).toBe("2027-04-09T23:59:59.999Z");
  });

  it("an end equal to now counts as passed (counted from now)", () => {
    expect(
      computeAccessExpiry(
        { kind: "months", months: 3 },
        { now, current: new Date(now) },
      )?.toISOString(),
    ).toBe("2027-01-09T23:59:59.999Z");
  });

  it("no current expiry (null) counts from today", () => {
    expect(
      computeAccessExpiry(
        { kind: "months", months: 12 },
        { now, current: null },
      )?.toISOString(),
    ).toBe("2027-10-09T23:59:59.999Z");
  });

  it("a custom day ends at its last UTC millisecond, even in the past", () => {
    expect(
      computeAccessExpiry(
        { kind: "date", date: "2027-05-01" },
        { now, current: at("2030-01-01T00:00:00Z") },
      )?.toISOString(),
    ).toBe("2027-05-01T23:59:59.999Z");
    expect(
      computeAccessExpiry(
        { kind: "date", date: "2026-10-01" },
        { now },
      )?.toISOString(),
    ).toBe("2026-10-01T23:59:59.999Z");
  });

  it("none is null; an invalid custom day throws", () => {
    expect(computeAccessExpiry({ kind: "none" }, { now })).toBeNull();
    expect(() =>
      computeAccessExpiry({ kind: "date", date: "2026-02-30" }, { now }),
    ).toThrow(RangeError);
  });
});
