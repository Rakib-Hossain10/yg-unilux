"use server";

// Server Actions for the access-request queue (Phase 5 P7, ADR 0069/0073):
// approve, reject, the manual WhatsApp entry, delete a handled request and a
// new invite link after an approval whose invite did not go out. Each one:
// requireAdmin() first → the P3 service with `{ id, headers }` (the service
// re-checks that actor from the database) → a refused actor (`denied`) is a
// 403 → revalidate the (always empty) tags → refresh() (or a redirect) when
// the request changed, so the uncached admin pages re-render. A new invite
// link changes nothing the request page shows, so it does not refresh.
//
// A copy-once invite link exists only in the value returned here: it is
// never logged, put in a URL or stored readable (plan Q1).

import { headers } from "next/headers";
import { refresh } from "next/cache";
import { forbidden, redirect } from "next/navigation";

import type {
  ActionData,
  ActionFailure,
  ActionResult,
} from "@/components/admin/action-result";
import {
  accessRequestPath,
  accessRequestsListPath,
} from "@/components/admin/access-requests/paths";
import type {
  ApproveOutcome,
  InviteView,
  NewInviteOutcome,
} from "@/components/admin/access-requests/types";
import {
  approveAccessRequest,
  createManualAccessRequest,
  deleteAccessRequest,
  rejectAccessRequest,
} from "@/lib/admin/access-requests";
import { regenerateInvite, type InviteOutcome } from "@/lib/admin/customers";
import {
  AUDIT_FAILED_MESSAGE,
  type ServiceResult,
} from "@/lib/admin/write-result";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";

/*
 * Every argument is `unknown`: an action is a public POST endpoint, so the
 * browser can send anything. The services re-parse it with the same Zod
 * schemas the dialogs use. The actor always comes from the session.
 *
 * No try/catch: requireAdmin() works by throwing, and catching it would let
 * a non-admin call through (ADR 0024).
 */

/*
 * The client's view of a failed call. These services change no catalog
 * tags, so "saved" is read from the one failure that comes after a write:
 * the audit entry (ADR 0035 point 5).
 */
function failure(
  result: ServiceResult<unknown> & { ok: false },
): ActionFailure {
  // A refused actor is a 403, never a form message (ADR 0073).
  if (result.denied) forbidden();
  return {
    ok: false,
    errors: result.errors,
    saved:
      result.tags.length > 0 ||
      result.errors.formErrors.includes(AUDIT_FAILED_MESSAGE),
  };
}

/* Dates become ISO strings; the link is kept only for the "copy" state. */
function inviteView(invite: InviteOutcome): InviteView {
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

/**
 * Approves a pending request: `{ requestId, name, company, country, access,
 * delivery, notifyExtension }`. Creates the customer (or extends an existing
 * one) and returns what happened, including a copy-once link when asked.
 */
export async function approveAccessRequestAction(
  input: unknown,
): Promise<ActionData<ApproveOutcome>> {
  const viewer = await requireAdmin();
  const result = await approveAccessRequest(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  refresh();
  const data = result.data;
  return {
    ok: true,
    data: {
      userId: data.userId,
      created: data.created,
      accessExpiresAt: data.accessExpiresAt?.toISOString() ?? null,
      invite: data.invite ? inviteView(data.invite) : null,
      notified: data.notified,
      blocked: data.blocked,
      inviteWithheld: data.inviteWithheld,
      auditMessage: data.auditFailed ? AUDIT_FAILED_MESSAGE : null,
    },
  };
}

/**
 * Rejects a pending request: `{ requestId, reason?, sendEmail? }`. The reason
 * stays internal; the polite decline email goes out only when asked.
 */
export async function rejectAccessRequestAction(
  input: unknown,
): Promise<ActionData<{ emailSent: boolean }>> {
  const viewer = await requireAdmin();
  const result = await rejectAccessRequest(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  if (!result.ok) {
    const answer = failure(result);
    if (answer.saved !== false) refresh();
    return answer;
  }
  refresh();
  return { ok: true, data: { emailSent: result.data.emailSent } };
}

/**
 * Adds a request received on WhatsApp (pending, source "whatsapp") and opens
 * it. A pending request for the same email is refused on the email field.
 */
export async function createManualAccessRequestAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await createManualAccessRequest(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  if (!result.ok) {
    const answer = failure(result);
    // Saved, but the audit entry failed: show the new row behind the dialog.
    if (answer.saved !== false) refresh();
    return answer;
  }
  redirect(accessRequestPath(result.data.requestId, "created"));
}

/**
 * Deletes a handled (approved or rejected) request, then shows the handled
 * list. A pending one is refused: reject it first.
 */
export async function deleteAccessRequestAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await deleteAccessRequest(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  // A saved delete whose audit entry failed is not refreshed: the page would
  // turn into "not found" and hide the message. The button stays disabled.
  if (!result.ok) return failure(result);
  redirect(accessRequestsListPath({ tab: "handled", notice: "deleted" }));
}

/**
 * A new invite link for the customer an approval made or extended, when its
 * invite did not go out: `{ userId, delivery }`. Earlier links die; the
 * access end date is untouched (plan Q1).
 */
export async function newInviteLinkAction(
  input: unknown,
): Promise<ActionData<NewInviteOutcome>> {
  const viewer = await requireAdmin();
  const result = await regenerateInvite(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  return {
    ok: true,
    data: {
      invite: inviteView(result.data.invite),
      auditMessage: result.data.auditFailed ? AUDIT_FAILED_MESSAGE : null,
    },
  };
}
