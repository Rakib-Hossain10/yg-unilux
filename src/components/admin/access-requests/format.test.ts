// The queue's date and label text. Dates are shown in China time with the
// zone written out (src/lib/time-zone.ts); access ends at the end of the
// chosen day there.

import { describe, expect, it } from "vitest";

import { formatAccessEnd, formatWait, labelOf, SOURCE_LABELS } from "./format";

describe("access-request format helpers", () => {
  it("prints an access end as the China-time day it ends on", () => {
    // 15:59:59.999 UTC = 23:59:59.999 in China (UTC+8).
    expect(formatAccessEnd(new Date("2027-03-31T15:59:59.999Z"))).toBe(
      "until the end of 31 Mar 2027 (China time)",
    );
    expect(formatAccessEnd("2027-03-31T15:59:59.999Z")).toBe(
      "until the end of 31 Mar 2027 (China time)",
    );
    expect(formatAccessEnd(null)).toBe("no expiry");
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
