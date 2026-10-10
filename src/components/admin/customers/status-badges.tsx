// The status badges of one customer (list row and page header): blocked,
// access state, invite state and "temporary password". Server-safe markup
// only (no client code).

import { Badge } from "@/components/ui/badge";

import type { AccessStateView, InviteStatusView } from "./labels";

export function CustomerStatusBadges({
  access,
  blocked,
  invite,
  mustChangePassword,
}: {
  access: AccessStateView;
  blocked: boolean;
  invite: InviteStatusView;
  mustChangePassword: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {blocked ? <Badge variant="destructive">Blocked</Badge> : null}
      {access === "expired" ? (
        <Badge variant="outline">Access expired</Badge>
      ) : access === "expiring" ? (
        <Badge variant="secondary">Expiring soon</Badge>
      ) : null}
      {invite.state === "pending" ? (
        <Badge variant="secondary">Invite pending</Badge>
      ) : invite.state === "expired" ? (
        <Badge variant="outline">Invite expired</Badge>
      ) : invite.state === "none" && mustChangePassword ? (
        <Badge variant="outline">Temporary password</Badge>
      ) : null}
      {!blocked &&
      (access === "active" || access === "no_expiry") &&
      (invite.state === "accepted" ||
        (invite.state === "none" && !mustChangePassword)) ? (
        <Badge>Active</Badge>
      ) : null}
    </div>
  );
}
