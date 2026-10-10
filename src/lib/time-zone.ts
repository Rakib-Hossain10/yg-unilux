// The site's display time zone and its calendar-day math. Pure and
// client-safe (no env, no server-only): server pages, client components and
// emails all format dates here, so the admin and the customer always see the
// same day.
//
// Dates are STORED in UTC (plain instants). They are SHOWN, and the days the
// admin picks are READ, in the zone below.
//
// THE SINGLE SETTING: changing these two constants changes the zone
// everywhere (display, expiry end-of-day, reminder window). Any IANA zone
// works, including ones with daylight saving: offsets are read from Intl at
// each instant, never hard-coded.

/** The IANA zone every date is shown and every picked day is read in. */
export const APP_TIME_ZONE = "Asia/Shanghai";
/** The words shown after a time, e.g. "14:30 (China time)". */
export const APP_TIME_ZONE_LABEL = "China time";

/** A date as accepted by the formatters. */
export type DateInput = Date | string | number;

/*
 * Month names are ours, not the locale's: strings are built from numeric
 * parts only, so Node and every browser produce the same bytes (no ICU
 * differences such as narrow no-break spaces or "Sept").
 */
const MONTHS = [
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
] as const;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** A wall-clock reading in some zone (month 1-12). */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** A calendar day (month 1-12). */
export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/* One numeric formatter per zone; "en-US" + numeric fields = digits only. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A valid Date from any input; RangeError for an unreadable one. */
export function toDate(input: DateInput): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid date");
  return date;
}

/** The wall-clock reading of `instant` in `timeZone`. */
export function wallTimeIn(instant: Date, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new RangeError(`Missing ${type} for ${timeZone}`);
    return Number(part.value);
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    // Some engines print midnight as "24" even with h23.
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

/* UTC offset of `timeZone` at `instantMs`, in ms (east of UTC positive). */
function offsetAt(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const wall = wallTimeIn(new Date(whole), timeZone);
  const asUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  return asUtc - whole;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function dayKeyOf(day: CalendarDay): string {
  return `${pad(day.year, 4)}-${pad(day.month)}-${pad(day.day)}`;
}

/** A "YYYY-MM-DD" string as a real calendar day, or null (2026-02-30). */
export function parseDayKey(key: string): CalendarDay | null {
  const match = DAY_KEY.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC maps years 0-99 to 1900-1999; setUTCFullYear keeps them.
  probe.setUTCFullYear(year);
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
    ? { year, month, day }
    : null;
}

/** `key` plus `days` calendar days (negative goes back); null if invalid. */
export function addDaysToDayKey(key: string, days: number): string | null {
  const day = parseDayKey(key);
  if (!day || !Number.isInteger(days)) return null;
  const date = new Date(
    Date.UTC(day.year, day.month - 1, day.day) + days * MS_PER_DAY,
  );
  return dayKeyOf({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
}

/**
 * `key` plus `months` calendar months. A day missing from the target month
 * is clamped to its last day (31 Jan + 1 month = 28/29 Feb), never rolled
 * into the next month. Null for an invalid key or a non-integer count.
 */
export function addMonthsToDayKey(key: string, months: number): string | null {
  const day = parseDayKey(key);
  if (!day || !Number.isInteger(months)) return null;
  const monthIndex = day.year * 12 + (day.month - 1) + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12 + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return dayKeyOf({ year, month, day: Math.min(day.day, lastDay) });
}

/** The "YYYY-MM-DD" calendar day of `input` in `timeZone`. */
export function zonedDayKeyIn(input: DateInput, timeZone: string): string {
  const wall = wallTimeIn(toDate(input), timeZone);
  return dayKeyOf(wall);
}

/**
 * The first instant of the calendar day `key` in `timeZone`, or null for an
 * invalid key. DST-safe: tries the zone's offsets around that midnight and
 * keeps the earliest instant that really reads as `key` there (when a zone
 * skips midnight, the day starts at the first wall time that exists).
 */
export function startOfZonedDayIn(key: string, timeZone: string): Date | null {
  const day = parseDayKey(key);
  if (!day) return null;
  const midnightAsUtc = new Date(Date.UTC(day.year, day.month - 1, day.day));
  midnightAsUtc.setUTCFullYear(day.year);
  const wallMs = midnightAsUtc.getTime();
  const offsets = new Set(
    [-MS_PER_DAY, 0, MS_PER_DAY].map((shift) =>
      offsetAt(wallMs + shift, timeZone),
    ),
  );
  let best: number | null = null;
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (zonedDayKeyIn(candidate, timeZone) !== key) continue;
    if (best === null || candidate < best) best = candidate;
  }
  return best === null ? null : new Date(best);
}

/**
 * The last millisecond of the calendar day `key` in `timeZone` (the instant
 * before the next day starts), or null for an invalid key.
 */
export function endOfZonedDayIn(key: string, timeZone: string): Date | null {
  const next = addDaysToDayKey(key, 1);
  if (next === null) return null;
  const start = startOfZonedDayIn(next, timeZone);
  return start === null ? null : new Date(start.getTime() - 1);
}

/** "10 Oct 2026" in `timeZone`. */
export function formatDateIn(input: DateInput, timeZone: string): string {
  const wall = wallTimeIn(toDate(input), timeZone);
  return `${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}`;
}

/** "10 Oct 2026, 14:30" in `timeZone` (24 h, no label). */
export function formatDateTimeIn(input: DateInput, timeZone: string): string {
  const wall = wallTimeIn(toDate(input), timeZone);
  return `${wall.day} ${MONTHS[wall.month - 1]} ${wall.year}, ${pad(wall.hour)}:${pad(wall.minute)}`;
}

// ---------------------------------------------------------------------------
// The app's zone (what the rest of the code uses)
// ---------------------------------------------------------------------------

/** "10 Oct 2026, 14:30 (China time)". RangeError for an invalid date. */
export function formatDateTime(d: DateInput): string {
  return `${formatDateTimeIn(d, APP_TIME_ZONE)} (${APP_TIME_ZONE_LABEL})`;
}

/**
 * "10 Oct 2026", or "10 Oct 2026 (China time)" with `label: true`.
 * RangeError for an invalid date.
 */
export function formatDate(d: DateInput, opts?: { label?: boolean }): string {
  const text = formatDateIn(d, APP_TIME_ZONE);
  return opts?.label === true ? `${text} (${APP_TIME_ZONE_LABEL})` : text;
}

/** The "YYYY-MM-DD" calendar day of `d` in the app's zone. */
export function zonedDayKey(d: DateInput): string {
  return zonedDayKeyIn(d, APP_TIME_ZONE);
}

/** The first instant of day `dayKey` in the app's zone; null if invalid. */
export function startOfZonedDay(dayKey: string): Date | null {
  return startOfZonedDayIn(dayKey, APP_TIME_ZONE);
}

/**
 * The last millisecond of day `dayKey` in the app's zone; null if invalid.
 * "2026-12-31" in China time = 2026-12-31T15:59:59.999Z.
 */
export function endOfZonedDay(dayKey: string): Date | null {
  return endOfZonedDayIn(dayKey, APP_TIME_ZONE);
}

/**
 * The end of the app-zone day `days` calendar days after `now`'s day
 * (0 = the end of today). The bound for "ends within N days" windows.
 */
export function endOfZonedDayAfter(now: DateInput, days: number): Date {
  const key = addDaysToDayKey(zonedDayKey(now), days);
  const end = key === null ? null : endOfZonedDay(key);
  if (end === null) throw new RangeError("Invalid day window");
  return end;
}
