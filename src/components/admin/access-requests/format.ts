// Labels and date text for the access-request queue. Dates are shown in UTC
// with "UTC" written next to them (plan Q5): the server and every browser
// then print the same text, and access always ends at 23:59 UTC.

const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const DAY_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function asDate(value: Date | string): Date {
  return typeof value === "string" ? new Date(value) : value;
}

/** "6 Oct 2026" ("—" for an unreadable date, never a render crash). */
export function formatDay(value: Date | string): string {
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? "—" : DAY.format(date);
}

/** "6 Oct 2026, 14:05 UTC". */
export function formatDayTime(value: Date | string): string {
  const date = asDate(value);
  return Number.isNaN(date.getTime()) ? "—" : `${DAY_TIME.format(date)} UTC`;
}

/** An access end date: "until 31 Mar 2027 (end of day, UTC)" or "no expiry". */
export function formatAccessEnd(value: Date | string | null): string {
  return value === null
    ? "no expiry"
    : `until ${formatDay(value)} (end of day, UTC)`;
}

export const SOURCE_LABELS: Record<string, string> = {
  form: "Website form",
  whatsapp: "WhatsApp (added by you)",
};

export const KIND_LABELS: Record<string, string> = {
  new: "New access",
  renewal: "Renewal",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

/** A label from one of the maps above, or the raw value as a fallback. */
export function labelOf(map: Record<string, string>, value: string): string {
  return Object.hasOwn(map, value) ? (map[value] ?? value) : value;
}

/** "about 12 minutes" for a retry wait in seconds (at least one minute). */
export function formatWait(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}
