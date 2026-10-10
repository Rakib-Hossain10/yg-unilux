// A customer from the P3 service as plain JSON for the client components:
// dates become ISO strings. Holds only what the admin screens show (never a
// token, a password or the device epoch; the service never reads them).

import "server-only";

import type { CustomerRowData } from "@/components/admin/customers/customers-table";
import type { InviteStatusView } from "@/components/admin/customers/labels";
import type { CustomerSummary } from "@/lib/admin/customers";
import type { InviteStatus } from "@/lib/invite";

export function inviteStatusView(invite: InviteStatus): InviteStatusView {
  switch (invite.state) {
    case "pending":
      return { state: "pending", until: invite.until.toISOString() };
    case "expired":
      return {
        state: "expired",
        expiredAt: invite.expiredAt?.toISOString() ?? null,
      };
    case "none":
    case "accepted":
      return { state: invite.state };
  }
}

export function customerRowView(customer: CustomerSummary): CustomerRowData {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    company: customer.company,
    country: customer.country,
    createdAt: customer.createdAt.toISOString(),
    accessExpiresAt: customer.accessExpiresAt?.toISOString() ?? null,
    access: customer.access,
    blocked: customer.blocked,
    mustChangePassword: customer.mustChangePassword,
    invite: inviteStatusView(customer.invite),
  };
}
