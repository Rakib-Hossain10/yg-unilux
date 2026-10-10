// Labels for the customers module: status filters, sorts, the access and
// invite states and the audit trail's actions. Client-safe (no imports of
// server code); the filter and sort maps are full records, so a new value
// fails tsc until it has a label.

import type {
  CustomerSort,
  CustomerStatusFilter,
} from "@/lib/schemas/customer";

import {
  endOfZonedDay,
  formatDate,
  formatDateTime,
  zonedDayKey,
} from "@/lib/time-zone";
import type { AdminAuditAction } from "@/models/audit-actions";

import { formatAccessEnd } from "../access-requests/format";

export const STATUS_FILTER_LABELS: Record<CustomerStatusFilter, string> = {
  active: "Active",
  expiring: "Expiring in 30 days",
  expired: "Access expired",
  blocked: "Blocked",
  invite_pending: "Invite pending",
  invite_expired: "Invite expired",
};

export const SORT_LABELS: Record<CustomerSort, string> = {
  created: "Newest first",
  expiry: "Access ends soonest",
  name: "Name A–Z",
};

/** Where a customer's access stands (the service's AccessState). */
export type AccessStateView = "no_expiry" | "active" | "expiring" | "expired";

/** The invite status as plain JSON (dates as ISO strings). */
export type InviteStatusView =
  | { state: "none" }
  | { state: "pending"; until: string }
  | { state: "expired"; expiredAt: string | null }
  | { state: "accepted" };

/** The access column: "Until 31 Mar 2027", "No expiry", "Ended …" (China time). */
export function accessText(
  access: AccessStateView,
  expiresAt: string | null,
): string {
  if (expiresAt === null) return "No expiry";
  return access === "expired"
    ? `Ended ${formatDate(expiresAt)}`
    : `Until ${formatDate(expiresAt)}`;
}

/* True when `iso` is the last millisecond of its China day (a picked end). */
function isEndOfDay(iso: string): boolean {
  return endOfZonedDay(zonedDayKey(iso))?.toISOString() === iso;
}

/**
 * The access line on the customer page, with the zone written out. An end
 * set by "End access now" is a moment, not the end of a day, so it reads
 * "Ended on 10 Oct 2026, 14:30 (China time)".
 */
export function accessSentence(
  access: AccessStateView,
  expiresAt: string | null,
): string {
  if (expiresAt === null) return "No expiry: datasheets stay unlocked.";
  if (access !== "expired") return `Access ${formatAccessEnd(expiresAt)}.`;
  return isEndOfDay(expiresAt)
    ? `Ended at the end of ${formatDate(expiresAt, { label: true })}. Downloads are locked.`
    : `Ended on ${formatDateTime(expiresAt)}. Downloads are locked.`;
}

/** The invite line on the customer page. */
export function inviteSentence(invite: InviteStatusView): string {
  switch (invite.state) {
    case "pending":
      return `Invite pending: the link works until ${formatDateTime(invite.until)}.`;
    case "expired":
      return invite.expiredAt
        ? `Invite expired on ${formatDateTime(invite.expiredAt)}. The password was never set.`
        : "Invite expired. The password was never set.";
    case "accepted":
      return "Invite accepted: the customer has set a password.";
    case "none":
      return "No invite link on record.";
  }
}

/** True when the invite is not settled, so "New invite link" is offered. */
export function inviteOpen(
  invite: InviteStatusView,
  mustChangePassword: boolean,
): boolean {
  if (invite.state === "pending" || invite.state === "expired") return true;
  // Never invited (or invite cleared by a temporary password) and the
  // password is still not their own: a link lets them choose one.
  return invite.state === "none" && mustChangePassword;
}

/* The actions the customer page's trail can show (others pass through). */
type CustomerTrailAction = Extract<
  AdminAuditAction,
  `customer.${string}` | `access_request.${string}`
>;

/* A full record: a new customer or access-request action fails tsc here. */
const AUDIT_LABELS: Record<CustomerTrailAction, string> = {
  "customer.create": "Account created",
  "customer.update": "Profile edited",
  "customer.access.set": "Access changed",
  "customer.access.end": "Access ended",
  "customer.ban": "Blocked",
  "customer.unban": "Unblocked",
  "customer.password.link": "Password reset link sent",
  "customer.password.temp": "Temporary password set",
  "customer.sessions.revoke": "Signed out everywhere",
  "customer.invite.resend": "New invite link made",
  "access_request.approve": "Access request approved",
  "access_request.reject": "Access request rejected",
  "access_request.create_manual": "WhatsApp request added",
  "access_request.delete": "Access request deleted",
};

/** A readable label for an audit action; unknown actions pass through. */
export function auditLabel(action: string): string {
  return Object.hasOwn(AUDIT_LABELS, action)
    ? (AUDIT_LABELS[action as CustomerTrailAction] ?? action)
    : action;
}
