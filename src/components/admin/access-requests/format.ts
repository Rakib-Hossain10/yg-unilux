// Labels and date text for the access-request queue and the customers
// module. Dates are formatted only by src/lib/time-zone.ts (shown in China
// time with the zone written out; stored in UTC).

import { formatDate } from "@/lib/time-zone";

/**
 * An access end: "until the end of 31 Mar 2027 (China time)", or "no expiry".
 * Access ends at the last moment of the chosen day in the app's zone.
 */
export function formatAccessEnd(value: Date | string | null): string {
  return value === null
    ? "no expiry"
    : `until the end of ${formatDate(value, { label: true })}`;
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
