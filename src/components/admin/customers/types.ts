// What the customer actions hand back to the client (plain JSON: dates are
// ISO strings). A copy-once invite link or a temporary password lives only
// in the component that asked for it and is dropped when it closes.

import type { InviteView } from "../access-requests/types";

export interface CreateCustomerOutcome {
  userId: string;
  /** ISO end of access, or null for no expiry. */
  accessExpiresAt: string | null;
  invite: InviteView;
  /** Set when the account is saved but its audit entry is not. */
  auditMessage: string | null;
}

export interface TemporaryPasswordOutcome {
  /** Shown once; never stored readable, logged or put in a URL. */
  password: string;
  auditMessage: string | null;
}
