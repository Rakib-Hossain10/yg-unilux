import { describe, expect, it } from "vitest";

import { tileRows } from "./area-tiles";

describe("tileRows (ui-reviewer gate C, M-6)", () => {
  it("splits the seven areas into a row of 3 and a row of 4", () => {
    expect(tileRows(7)).toEqual([3, 4]);
  });

  it("never leaves a hole: every row has 1 to 4 tiles and the sum is the count", () => {
    for (let count = 1; count <= 24; count += 1) {
      const rows = tileRows(count);
      expect(rows.reduce((a, b) => a + b, 0)).toBe(count);
      expect(Math.max(...rows)).toBeLessThanOrEqual(4);
      expect(Math.min(...rows)).toBeGreaterThanOrEqual(1);
      // Shorter rows first, never more than one tile apart.
      expect([...rows].sort((a, b) => a - b)).toEqual(rows);
      expect(Math.max(...rows) - Math.min(...rows)).toBeLessThanOrEqual(1);
    }
  });

  it("handles small and empty lists", () => {
    expect(tileRows(0)).toEqual([]);
    expect(tileRows(1)).toEqual([1]);
    expect(tileRows(3)).toEqual([3]);
    expect(tileRows(5)).toEqual([2, 3]);
    expect(tileRows(8)).toEqual([4, 4]);
  });
});
