// The access line on /my-downloads (plan Q8), from the same rule the download
// route uses (permissions.checkDatasheetAccess), plus the date formats of the
// account pages. Pure. Dates come from src/lib/time-zone.ts (China time), the
// single display-zone module shared with the emails and the admin screens,
// so the customer sees the day the admin picked. Server-side only (permissions.ts is server-only).

import { type AccessUser, checkDatasheetAccess } from "@/lib/permissions";
import { formatDate, formatDateTime } from "@/lib/time-zone";

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

/** "31 Mar 2027": the app-zone calendar day (access ends at its end). */
export function formatDay(date: Date): string {
  return formatDate(date);
}

/** "9 Oct 2026, 14:05 (China time)". */
export function formatMoment(date: Date): string {
  return formatDateTime(date);
}
