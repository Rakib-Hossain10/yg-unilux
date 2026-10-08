// Pure helpers of the settings UI (T15). Client-safe: no server imports.

import type { ColumnVisibility } from "@/lib/schemas/settings";
import {
  FILTER_KEY_BY_SPEC,
  SPEC_COLUMNS,
  type SpecKey,
} from "@/models/spec-columns";

/**
 * The columns that feed a listing filter, derived from the shared
 * FILTER_KEY_BY_SPEC map (pure module, so client-safe).
 */
export const FILTER_COLUMNS: readonly SpecKey[] = Object.keys(
  FILTER_KEY_BY_SPEC,
) as SpecKey[];

const HEADER = new Map<string, string>(
  SPEC_COLUMNS.map((column) => [column.key, column.header]),
);

/** Headers of the filter columns that `next` makes restricted but `saved` has public. */
export function newlyRestrictedFilterHeaders(
  saved: ColumnVisibility,
  next: ColumnVisibility,
): string[] {
  return FILTER_COLUMNS.filter(
    (key) => saved[key] === "public" && next[key] === "restricted",
  ).map((key) => HEADER.get(key) ?? key);
}

/** How many columns each side of the form holds, for the summary line. */
export function countRestricted(values: ColumnVisibility): number {
  return SPEC_COLUMNS.filter((c) => values[c.key] === "restricted").length;
}

/** True when two visibility maps differ in any column. */
export function visibilityChanged(
  a: ColumnVisibility,
  b: ColumnVisibility,
): boolean {
  return SPEC_COLUMNS.some((c) => a[c.key] !== b[c.key]);
}

/**
 * Whether Save is enabled. After a save whose product cleanup failed the
 * setting is stored (so nothing "changed") but the admin must be able to
 * save again to retry the cleanup.
 */
export function canSave(opts: {
  pending: boolean;
  changed: boolean;
  needsRetry: boolean;
}): boolean {
  return !opts.pending && (opts.changed || opts.needsRetry);
}
