// The access line on /my-downloads (plan Q8), from the same rule the download
// route uses (permissions.checkDatasheetAccess), plus the date formats of the
// account pages. Pure; dates are shown in UTC because expiry is stored as the
// end of a UTC day (plan Q5), and the page renders on the server. Server-side
// only (permissions.ts is server-only).

import { type AccessUser, checkDatasheetAccess } from "@/lib/permissions";

export type AccessStatus =
  | { kind: "admin" }
  | { kind: "active"; until: Date }
  | { kind: "open" }
  | { kind: "expired"; since: Date | null }
  | { kind: "password" }
  | { kind: "paused" }
  | { kind: "none" };

/* A readable date, or null for missing or unreadable values. */
function dateOf(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function accessStatus(user: AccessUser, now: Date): AccessStatus {
  const access = checkDatasheetAccess(user, now);
  if (access.ok) {
    const roles = typeof user.role === "string" ? user.role.split(",") : [];
    if (roles.map((r) => r.trim()).includes("admin")) return { kind: "admin" };
    const until = dateOf(user.accessExpiresAt);
    return until ? { kind: "active", until } : { kind: "open" };
  }
  switch (access.reason) {
    case "expired":
      return { kind: "expired", since: dateOf(user.accessExpiresAt) };
    case "must-change-password":
      return { kind: "password" };
    case "banned":
      return { kind: "paused" };
    default:
      return { kind: "none" };
  }
}

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const momentFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

/** "31 March 2027" (UTC). */
export function formatDay(date: Date): string {
  return dayFormat.format(date);
}

/** "9 Oct 2026, 14:05 UTC". */
export function formatMoment(date: Date): string {
  return `${momentFormat.format(date)} UTC`;
}
