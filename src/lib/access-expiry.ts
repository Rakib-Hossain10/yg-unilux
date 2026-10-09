// Datasheet-access expiry math (plan Q5, ADR 0070): 3 / 6 / 12 months, a
// custom date, or no expiry. Pure and client-safe, so the admin dialogs can
// preview exactly the date the server will store.

/** The month presets the admin can pick. */
export const ACCESS_MONTH_CHOICES = [3, 6, 12] as const;
export type AccessMonths = (typeof ACCESS_MONTH_CHOICES)[number];

/** What the admin chose in an expiry picker. */
export type AccessChoice =
  | { kind: "months"; months: AccessMonths }
  /** A calendar day, "YYYY-MM-DD"; access ends at the end of it (UTC). */
  | { kind: "date"; date: string }
  /** No end date. */
  | { kind: "none" };

/** Earliest and latest custom day accepted (sanity bounds, not policy). */
export const MIN_ACCESS_DATE = "2000-01-01";
export const MAX_ACCESS_DATE = "2100-12-31";

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The last millisecond of `date`'s UTC day: 23:59:59.999Z. */
export function endOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

/*
 * `date` plus `months` calendar months in UTC, keeping the time of day.
 * A day that doesn't exist in the target month is clamped to its last day
 * (31 January + 1 month = 28/29 February), never rolled into the next month.
 */
export function addUtcMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

/**
 * A "YYYY-MM-DD" string as the start of that UTC day, or null when it is
 * not a real calendar day (2026-02-30) or outside the sanity bounds.
 */
export function parseAccessDay(value: string): Date | null {
  const match = DAY_PATTERN.exec(value);
  if (!match) return null;
  if (value < MIN_ACCESS_DATE || value > MAX_ACCESS_DATE) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

/**
 * The `accessExpiresAt` to store for a choice:
 * - months: counted from the LATER of today and the current expiry, so an
 *   extension never shortens access and an expired customer gets the full
 *   period from today; then the end of that UTC day;
 * - date: the end of that UTC day (a past day is allowed: it ends access);
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
      const day = parseAccessDay(choice.date);
      if (!day) throw new RangeError("Invalid access day");
      return endOfUtcDay(day);
    }
    case "months": {
      const current = options.current ?? null;
      const base =
        current !== null && current.getTime() > options.now.getTime()
          ? current
          : options.now;
      return endOfUtcDay(addUtcMonths(base, choice.months));
    }
  }
}
