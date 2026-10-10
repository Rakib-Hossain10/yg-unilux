// Shared steps of the Phase 5 admin Server Actions (access requests P7,
// customers P8): how a failed service result reaches the client, and an
// invite outcome as plain JSON. A refused actor (`denied`) is a 403, never a
// form message (ADR 0073). Server-only: not a "use server" module, so none of
// this is a public endpoint.

import "server-only";

import { forbidden } from "next/navigation";

import type { ActionFailure } from "@/components/admin/action-result";
import type { InviteView } from "@/components/admin/access-requests/types";
import type { InviteOutcome } from "@/lib/admin/customers";
import {
  AUDIT_FAILED_MESSAGE,
  type ServiceResult,
} from "@/lib/admin/write-result";

/*
 * The client's view of a failed call. These services change no catalog
 * tags, so "saved" is read from the one failure that comes after a write:
 * the audit entry (ADR 0035 point 5).
 */
export function failure(
  result: ServiceResult<unknown> & { ok: false },
): ActionFailure {
  if (result.denied) forbidden();
  return {
    ok: false,
    errors: result.errors,
    saved:
      result.tags.length > 0 ||
      result.errors.formErrors.includes(AUDIT_FAILED_MESSAGE),
  };
}

/*
 * Dates become ISO strings; the link is kept only for the "copy" state, so a
 * stray `url` on any other state never reaches the browser.
 */
export function inviteView(invite: InviteOutcome): InviteView {
  switch (invite.state) {
    case "sent":
    case "send_failed":
      return { state: invite.state, expiresAt: invite.expiresAt.toISOString() };
    case "copy":
      return {
        state: "copy",
        url: invite.url,
        expiresAt: invite.expiresAt.toISOString(),
      };
    case "limited":
      return {
        state: "limited",
        retryAfterSeconds: invite.retryAfterSeconds,
      };
    case "busy":
    case "failed":
      return { state: invite.state };
  }
}

/** The audit-failure message for a result that kept its one-time data. */
export function auditMessage(auditFailed: boolean): string | null {
  return auditFailed ? AUDIT_FAILED_MESSAGE : null;
}
