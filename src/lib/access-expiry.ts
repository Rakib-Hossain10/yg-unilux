// Datasheet-access expiry math (plan Q5, ADR 0070): 3 / 6 / 12 months, a
// custom date, or no expiry. Pure and client-safe, so the admin dialogs can
// preview exactly the date the server will store. Days are calendar days in
// the app's zone (src/lib/time-zone.ts, China time): "expires 31 Dec" means
// access ends at the end of 31 Dec there (2026-12-31T15:59:59.999Z).

import {
  addMonthsToDayKey,
  endOfZonedDay,
  parseDayKey,
  startOfZonedDay,
  zonedDayKey,
} from "@/lib/time-zone";

/** The month presets the admin can pick. */
export const ACCESS_MONTH_CHOICES = [3, 6, 12] as const;
export type AccessMonths = (typeof ACCESS_MONTH_CHOICES)[number];

/** What the admin chose in an expiry picker. */
export type AccessChoice =
  | { kind: "months"; months: AccessMonths }
  /** A calendar day, "YYYY-MM-DD"; access ends at the end of it in the app zone. */
  | { kind: "date"; date: string }
  /** No end date. */
  | { kind: "none" };

/**
 * Earliest and latest custom day accepted (sanity bounds, not policy),
 * compared as app-zone calendar days.
 */
export const MIN_ACCESS_DATE = "2000-01-01";
export const MAX_ACCESS_DATE = "2100-12-31";

/**
 * A "YYYY-MM-DD" string as the start of that day in the app's zone
 * (APP_TIME_ZONE), or null when it is not a real calendar day (2026-02-30)
 * or outside the sanity bounds.
 */
export function parseAccessDay(value: string): Date | null {
  if (parseDayKey(value) === null) return null;
  if (value < MIN_ACCESS_DATE || value > MAX_ACCESS_DATE) return null;
  return startOfZonedDay(value);
}

/**
 * The `accessExpiresAt` to store for a choice:
 * - months: counted from the LATER of today and the current expiry, so an
 *   extension never shortens access and an expired customer gets the full
 *   period from today. The months are added to that instant's calendar day
 *   in the app zone (clamped at month end: 31 Jan + 1 = 28/29 Feb), then
 *   access runs to the end of the resulting zone day;
 * - date: the end of that zone day (a past day is allowed: it ends access);
 * - none: null (no expiry).
 * `current` = null means no expiry today (or a new account): counted from now.
 * Throws RangeError on an invalid custom day (schemas reject it first).
 */
export function computeAccessExpiry(
  choice: AccessChoice,
  options: { now: Date; current?: Date | null },
): Date | null {
  switch (choice.kind) {
    case "none":
      return null;
    case "date": {
      if (parseAccessDay(choice.date) === null) {
        throw new RangeError("Invalid access day");
      }
      const end = endOfZonedDay(choice.date);
      if (end === null) throw new RangeError("Invalid access day");
      return end;
    }
    case "months": {
      const current = options.current ?? null;
      const base =
        current !== null && current.getTime() > options.now.getTime()
          ? current
          : options.now;
      const target = addMonthsToDayKey(zonedDayKey(base), choice.months);
      const end = target === null ? null : endOfZonedDay(target);
      if (end === null) throw new RangeError("Invalid access period");
      return end;
    }
  }
}
