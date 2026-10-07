// How the specs editor groups the 28 sheet spec columns (Housing and optics,
// Light source, Electrical ...). Groups follow SPEC_COLUMNS order and are
// contiguous, so the editor reads like the client's sheet. Pure, client-safe.

import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  SPEC_COLUMNS,
  type SpecKey,
} from "@/models/spec-columns";

/** One titled group of spec columns, in sheet order. */
export interface SpecGroup {
  title: string;
  /**
   * `restrictedByDefault` is the sheet default, not the admin's current
   * column-visibility setting (a later task passes the effective one in).
   */
  columns: { key: SpecKey; header: string; restrictedByDefault: boolean }[];
}

/*
 * The group a column starts. SPEC_COLUMNS has no group field yet (a proposed
 * backend change); until then the editor names the groups here. A column
 * without an entry stays in the group above it, so the groups can never skip
 * or reorder a column (a unit test checks they cover all 28 in order).
 */
const GROUP_STARTS: Partial<Record<SpecKey, string>> = {
  batchNo: "Identification",
  housingMaterial: "Housing and optics",
  cutOutSize: "Size and mounting",
  chipType: "Light source",
  driver: "Electrical and output",
  lifespan: "Lifetime and protection",
};

const RESTRICTED = new Set<SpecKey>(DEFAULT_RESTRICTED_SPEC_KEYS);

/** The spec columns grouped for the editor, in SPEC_COLUMNS order. */
export const SPEC_GROUPS: readonly SpecGroup[] = SPEC_COLUMNS.reduce<
  SpecGroup[]
>((groups, column) => {
  const start = GROUP_STARTS[column.key];
  if (start !== undefined || groups.length === 0) {
    groups.push({ title: start ?? "Specs", columns: [] });
  }
  groups[groups.length - 1]?.columns.push({
    key: column.key,
    header: column.header,
    restrictedByDefault: RESTRICTED.has(column.key),
  });
  return groups;
}, []);

/** The English header of a spec key, e.g. "beamAngle" -> "Beam Angle". */
export const SPEC_HEADER = new Map<SpecKey, string>(
  SPEC_COLUMNS.map((column) => [column.key, column.header]),
);

/** The header for any key (e.g. from an error path); unknown keys as-is. */
export function specHeader(key: string): string {
  return SPEC_HEADER.get(key as SpecKey) ?? key;
}

/** True for the columns restricted by default (Batch No., Driver ...). */
export function isRestrictedByDefault(key: SpecKey): boolean {
  return RESTRICTED.has(key);
}
