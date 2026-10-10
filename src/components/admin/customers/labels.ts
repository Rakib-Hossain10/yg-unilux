// Labels for the customers module: status filters, sorts, the access and
// invite states and the audit trail's actions. Client-safe (no imports of
// server code); the filter and sort maps are full records, so a new value
// fails tsc until it has a label.

import type {
  CustomerSort,
  CustomerStatusFilter,
} from "@/lib/schemas/customer";

import { formatDate, formatDateTime } from "@/lib/time-zone";

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

/** The access line on the customer page, with the zone written out. */
export function accessSentence(
  access: AccessStateView,
  expiresAt: string | null,
): string {
  if (expiresAt === null) return "No expiry: datasheets stay unlocked.";
  return access === "expired"
    ? `Ended at the end of ${formatDate(expiresAt, { label: true })}. Downloads are locked.`
    : `Access ${formatAccessEnd(expiresAt)}.`;
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
const AUDIT_LABELS: Record<string, string> = {
  "customer.create": "Account created",
  "customer.update": "Profile edited",
  "customer.access.set": "Access changed",
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
    ? (AUDIT_LABELS[action] ?? action)
    : action;
}
