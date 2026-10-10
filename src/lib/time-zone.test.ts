// Tests for the display zone module: China-time formatting, zoned calendar
// days around 16:00Z (= midnight in Shanghai), end-of-day, month clamping,
// leap days, invalid keys, a DST zone through the generic helpers, and
// output that never depends on the host zone or ICU spacing.

import { describe, expect, it, vi } from "vitest";

import {
  APP_TIME_ZONE,
  APP_TIME_ZONE_LABEL,
  addDaysToDayKey,
  addMonthsToDayKey,
  endOfZonedDay,
  endOfZonedDayAfter,
  endOfZonedDayIn,
  formatDate,
  formatDateTime,
  formatDateTimeIn,
  parseDayKey,
  startOfZonedDay,
  startOfZonedDayIn,
  zonedDayKey,
  zonedDayKeyIn,
} from "./time-zone";

const iso = (d: Date | null) => d?.toISOString() ?? null;
const ASCII = /^[\x20-\x7e]+$/;

describe("the setting", () => {
  it("is China time", () => {
    expect(APP_TIME_ZONE).toBe("Asia/Shanghai");
    expect(APP_TIME_ZONE_LABEL).toBe("China time");
  });
});

describe("formatDateTime", () => {
  it("shows China time with the label, 24 h", () => {
    expect(formatDateTime(new Date("2026-10-10T06:30:00Z"))).toBe(
      "10 Oct 2026, 14:30 (China time)",
    );
    expect(formatDateTime("2026-01-02T15:59:00Z")).toBe(
      "2 Jan 2026, 23:59 (China time)",
    );
  });

  it("rolls to the next day at 16:00Z and prints midnight as 00:00", () => {
    expect(formatDateTime(Date.parse("2026-10-09T16:00:00Z"))).toBe(
      "10 Oct 2026, 00:00 (China time)",
    );
  });

  it("rejects an unreadable date", () => {
    expect(() => formatDateTime("not a date")).toThrow(RangeError);
    expect(() => formatDate(Number.NaN)).toThrow(RangeError);
  });
});

describe("formatDate", () => {
  it("is the China calendar day, with an optional label", () => {
    expect(formatDate(new Date("2026-12-31T15:59:59.999Z"))).toBe(
      "31 Dec 2026",
    );
    expect(formatDate(new Date("2026-12-31T16:00:00.000Z"))).toBe("1 Jan 2027");
    expect(formatDate("2026-10-10T00:00:00Z", { label: true })).toBe(
      "10 Oct 2026 (China time)",
    );
    expect(formatDate("2026-10-10T00:00:00Z", { label: false })).toBe(
      "10 Oct 2026",
    );
  });
});

describe("output is the same on any host", () => {
  it("does not depend on the host zone and is plain ASCII", () => {
    const instant = new Date("2026-03-29T00:30:00Z");
    const expected = "29 Mar 2026, 08:30 (China time)";
    for (const tz of [
      "UTC",
      "America/Los_Angeles",
      "Asia/Kolkata",
      "Europe/London",
    ]) {
      vi.stubEnv("TZ", tz);
      expect(formatDateTime(instant)).toBe(expected);
      expect(zonedDayKey(instant)).toBe("2026-03-29");
      expect(endOfZonedDay("2026-03-29")?.toISOString()).toBe(
        "2026-03-29T15:59:59.999Z",
      );
    }
    expect(formatDateTime(instant)).toMatch(ASCII);
    expect(formatDate(instant, { label: true })).toMatch(ASCII);
  });

  it("names every month the same way", () => {
    const names = Array.from(
      { length: 12 },
      (_, m) => formatDate(new Date(Date.UTC(2026, m, 15, 4))).split(" ")[1],
    );
    expect(names).toEqual([
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]);
  });
});

describe("zonedDayKey", () => {
  it("switches day at 16:00Z (midnight in Shanghai)", () => {
    expect(zonedDayKey(new Date("2026-10-09T15:59:59.999Z"))).toBe(
      "2026-10-09",
    );
    expect(zonedDayKey(new Date("2026-10-09T16:00:00.000Z"))).toBe(
      "2026-10-10",
    );
    expect(zonedDayKey("2026-12-31T16:00:00Z")).toBe("2027-01-01");
  });
});

describe("startOfZonedDay / endOfZonedDay", () => {
  it("are 16:00Z the day before and 15:59:59.999Z", () => {
    expect(iso(startOfZonedDay("2026-12-31"))).toBe("2026-12-30T16:00:00.000Z");
    expect(iso(endOfZonedDay("2026-12-31"))).toBe("2026-12-31T15:59:59.999Z");
  });

  it("handle a leap day", () => {
    expect(iso(endOfZonedDay("2028-02-29"))).toBe("2028-02-29T15:59:59.999Z");
    expect(endOfZonedDay("2027-02-29")).toBeNull();
  });

  it("return null for invalid keys", () => {
    for (const key of [
      "",
      "2026-13-01",
      "2026-02-30",
      "2026-1-01",
      "2026-01-01T00:00",
      "abcd-ef-gh",
    ]) {
      expect(endOfZonedDay(key)).toBeNull();
      expect(startOfZonedDay(key)).toBeNull();
    }
  });

  it("round-trip: the end reads as that day, one ms later is the next", () => {
    const end = endOfZonedDay("2026-10-10");
    expect(end).not.toBeNull();
    expect(zonedDayKey(end as Date)).toBe("2026-10-10");
    expect(zonedDayKey((end as Date).getTime() + 1)).toBe("2026-10-11");
  });
});

describe("endOfZonedDayAfter", () => {
  it("is the end of the China day N days after now's China day", () => {
    // 2026-10-09T17:00Z is already 10 Oct in China.
    expect(iso(endOfZonedDayAfter(new Date("2026-10-09T17:00:00Z"), 0))).toBe(
      "2026-10-10T15:59:59.999Z",
    );
    expect(iso(endOfZonedDayAfter(new Date("2026-10-09T15:00:00Z"), 7))).toBe(
      "2026-10-16T15:59:59.999Z",
    );
  });
});

describe("day-key arithmetic", () => {
  it("adds days across month and year ends", () => {
    expect(addDaysToDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDayKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToDayKey("2026-02-30", 1)).toBeNull();
    expect(addDaysToDayKey("2026-01-01", 1.5)).toBeNull();
  });

  it("adds months, clamping to the month's last day", () => {
    expect(addMonthsToDayKey("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToDayKey("2027-11-30", 3)).toBe("2028-02-29");
    expect(addMonthsToDayKey("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonthsToDayKey("2026-10-10", 12)).toBe("2027-10-10");
    expect(addMonthsToDayKey("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonthsToDayKey("bad", 3)).toBeNull();
  });

  it("parses only real calendar days", () => {
    expect(parseDayKey("2028-02-29")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
    expect(parseDayKey("2100-02-29")).toBeNull();
    expect(parseDayKey("2026-04-31")).toBeNull();
  });
});

describe("generic helpers in a DST zone (Europe/London)", () => {
  const LONDON = "Europe/London";

  it("use the summer offset (+1) and the winter offset (0)", () => {
    expect(iso(endOfZonedDayIn("2026-07-01", LONDON))).toBe(
      "2026-07-01T22:59:59.999Z",
    );
    expect(iso(endOfZonedDayIn("2026-12-01", LONDON))).toBe(
      "2026-12-01T23:59:59.999Z",
    );
    expect(formatDateTimeIn("2026-07-01T12:00:00Z", LONDON)).toBe(
      "1 Jul 2026, 13:00",
    );
  });

  it("handle the 23-hour spring-forward day", () => {
    // Clocks go 01:00 GMT -> 02:00 BST on 29 Mar 2026.
    const start = startOfZonedDayIn("2026-03-29", LONDON);
    const end = endOfZonedDayIn("2026-03-29", LONDON);
    expect(iso(start)).toBe("2026-03-29T00:00:00.000Z");
    expect(iso(end)).toBe("2026-03-29T22:59:59.999Z");
    expect((end as Date).getTime() - (start as Date).getTime() + 1).toBe(
      23 * 3_600_000,
    );
  });

  it("handle the 25-hour fall-back day", () => {
    // Clocks go 02:00 BST -> 01:00 GMT on 25 Oct 2026.
    const start = startOfZonedDayIn("2026-10-25", LONDON);
    const end = endOfZonedDayIn("2026-10-25", LONDON);
    expect(iso(start)).toBe("2026-10-24T23:00:00.000Z");
    expect(iso(end)).toBe("2026-10-25T23:59:59.999Z");
    expect((end as Date).getTime() - (start as Date).getTime() + 1).toBe(
      25 * 3_600_000,
    );
  });

  it("switch the day key at local midnight", () => {
    expect(zonedDayKeyIn("2026-07-01T22:59:59.999Z", LONDON)).toBe(
      "2026-07-01",
    );
    expect(zonedDayKeyIn("2026-07-01T23:00:00.000Z", LONDON)).toBe(
      "2026-07-02",
    );
  });

  it("start the day at the first wall time when a zone skips midnight", () => {
    // America/Santiago springs forward at 24:00 -> 01:00 on 6 Sep 2026.
    const start = startOfZonedDayIn("2026-09-06", "America/Santiago");
    expect(iso(start)).toBe("2026-09-06T04:00:00.000Z"); // 01:00 -03
    expect(zonedDayKeyIn(start as Date, "America/Santiago")).toBe("2026-09-06");
    expect(
      zonedDayKeyIn((start as Date).getTime() - 1, "America/Santiago"),
    ).toBe("2026-09-05");
  });
});
