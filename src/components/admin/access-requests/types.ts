// What the access-request actions hand back to the dialogs (plain JSON:
// dates are ISO strings). A copy-once invite link appears only in the "copy"
// state, lives only in the dialog's memory and is dropped when it closes.

/** The outcome of making an invite link, as the admin sees it. */
export type InviteView =
  | { state: "sent"; expiresAt: string }
  | { state: "copy"; url: string; expiresAt: string }
  /** The link was made (earlier ones are dead) but the email failed. */
  | { state: "send_failed"; expiresAt: string }
  | { state: "limited"; retryAfterSeconds: number }
  /** Another link for this customer is being made right now. */
  | { state: "busy" }
  | { state: "failed" };

/** How a new link reaches the customer. */
export type InviteDeliveryChoice = "email" | "copy";

export interface ApproveOutcome {
  userId: string;
  /** True: a new customer account; false: an existing one was extended. */
  created: boolean;
  /** ISO end of access, or null for no expiry. */
  accessExpiresAt: string | null;
  /** Null when no invite was due (or it was withheld). */
  invite: InviteView | null;
  /** Existing customers: the "access extended" email went out. */
  notified: boolean;
  /** The existing account is blocked (approving does not unblock it). */
  blocked: boolean;
  /** An invite was due but the customer is blocked, so none was made. */
  inviteWithheld: boolean;
  /** Set when the approval is saved but its audit entry is not. */
  auditMessage: string | null;
}

export interface NewInviteOutcome {
  invite: InviteView;
  auditMessage: string | null;
}

/** True when the invite did not reach the customer and a new link helps. */
export function inviteNeedsRetry(invite: InviteView | null): boolean {
  return invite !== null && invite.state !== "sent" && invite.state !== "copy";
}
