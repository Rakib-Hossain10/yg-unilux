// Tests for the datasheet button state (P7): every access result, with and
// without a datasheet.

import { describe, expect, it } from "vitest";

import { datasheetButtonState, refusedAccess } from "./datasheet-state";
import type { AccessDenial } from "./permissions";

describe("datasheetButtonState", () => {
  it("is download for an allowed viewer with a datasheet", () => {
    expect(datasheetButtonState({ ok: true, user: { id: "u1" } }, true)).toBe(
      "download",
    );
  });

  it.each<[AccessDenial, string]>([
    ["signed-out", "signin"],
    ["must-change-password", "signin"],
    ["not-allowed", "signin"],
    ["expired", "expired"],
    ["banned", "expired"],
  ])("maps %s to %s", (reason, state) => {
    expect(datasheetButtonState({ ok: false, reason }, true)).toBe(state);
  });

  it.each<[AccessDenial, string]>([
    ["signed-out", "signin"],
    ["must-change-password", "signin"],
    ["not-allowed", "signin"],
    ["expired", "expired"],
    ["banned", "expired"],
  ])("refusedAccess maps %s to %s", (reason, access) => {
    expect(refusedAccess(reason)).toBe(access);
  });

  it("is coming-soon for every viewer when there is no datasheet", () => {
    expect(datasheetButtonState({ ok: true, user: { id: "u1" } }, false)).toBe(
      "coming-soon",
    );
    expect(
      datasheetButtonState({ ok: false, reason: "signed-out" }, false),
    ).toBe("coming-soon");
  });
});
