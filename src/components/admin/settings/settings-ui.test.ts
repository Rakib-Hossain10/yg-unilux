// Pure helpers of the settings UI (T15) and their link to the service.

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_COLUMN_VISIBILITY } from "@/lib/schemas/settings";
import { SPEC_KEYS } from "@/models/spec-columns";

import { SPEC_GROUPS } from "../product-form/spec-groups";
import {
  canSave,
  countRestricted,
  FILTER_COLUMNS,
  newlyRestrictedFilterHeaders,
  visibilityChanged,
} from "./settings-ui";

vi.mock("server-only", () => ({}));

describe("settings UI helpers", () => {
  const saved = { ...DEFAULT_COLUMN_VISIBILITY };

  it("the filter column list equals the service's", async () => {
    const { FILTER_KEY_BY_SPEC } = await import("@/lib/admin/settings");
    expect([...FILTER_COLUMNS].sort()).toEqual(
      Object.keys(FILTER_KEY_BY_SPEC).sort(),
    );
  });

  it("warns only for filter columns that were public and become restricted", () => {
    const next = {
      ...saved,
      cct: "restricted" as const,
      lens: "restricted" as const,
      driver: "public" as const,
    };
    expect(newlyRestrictedFilterHeaders(saved, next)).toEqual(["CCT"]);
    expect(newlyRestrictedFilterHeaders(saved, saved)).toEqual([]);
  });

  it("counts restricted columns: five by default", () => {
    expect(countRestricted(saved)).toBe(5);
  });

  it("detects a change", () => {
    expect(visibilityChanged(saved, saved)).toBe(false);
    expect(visibilityChanged(saved, { ...saved, lens: "restricted" })).toBe(
      true,
    );
  });

  it("the groups show all 28 columns once", () => {
    const keys = SPEC_GROUPS.flatMap((g) => g.columns.map((c) => c.key));
    expect(keys).toEqual([...SPEC_KEYS]);
  });

  it("Save needs a change, or a retry after a failed cleanup", () => {
    const base = { pending: false, changed: false, needsRetry: false };
    expect(canSave(base)).toBe(false);
    expect(canSave({ ...base, changed: true })).toBe(true);
    expect(canSave({ ...base, needsRetry: true })).toBe(true);
    expect(canSave({ ...base, changed: true, pending: true })).toBe(false);
  });
});
