// The queue's date and label text (plan Q5: UTC, "UTC" written out).

import { describe, expect, it } from "vitest";

import {
  formatAccessEnd,
  formatDay,
  formatDayTime,
  formatWait,
  labelOf,
  SOURCE_LABELS,
} from "./format";

describe("access-request format helpers", () => {
  it("prints an access end as the UTC day", () => {
    expect(formatAccessEnd(new Date("2027-03-31T23:59:59.999Z"))).toBe(
      "until 31 Mar 2027 (end of day, UTC)",
    );
    expect(formatAccessEnd("2027-03-31T23:59:59.999Z")).toBe(
      "until 31 Mar 2027 (end of day, UTC)",
    );
    expect(formatAccessEnd(null)).toBe("no expiry");
  });

  it("prints a time in UTC with the zone written out", () => {
    expect(formatDayTime("2026-10-13T09:05:00.000Z")).toBe(
      "13 Oct 2026, 09:05 UTC",
    );
    expect(formatDay("2026-10-13T23:30:00.000Z")).toBe("13 Oct 2026");
  });

  it("never crashes on an unreadable date", () => {
    expect(formatDay("garbage")).toBe("—");
    expect(formatDayTime("garbage")).toBe("—");
  });

  it("labels known values and passes others through, prototype keys included", () => {
    expect(labelOf(SOURCE_LABELS, "form")).toBe("Website form");
    expect(labelOf(SOURCE_LABELS, "fax")).toBe("fax");
    expect(labelOf(SOURCE_LABELS, "constructor")).toBe("constructor");
  });

  it("rounds a retry wait up to whole minutes", () => {
    expect(formatWait(30)).toBe("about a minute");
    expect(formatWait(601)).toBe("about 11 minutes");
  });
});
