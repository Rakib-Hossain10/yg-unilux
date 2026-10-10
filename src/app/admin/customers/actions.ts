"use server";

// Server Actions for the customers module (Phase 5 P8, ADR 0070/0073):
// create, edit the profile, set or extend access, block / unblock, end
// sessions, send a reset link, set a temporary password and make a new
// invite link. Each one: requireAdmin() first → the P3 service with
// `{ id, headers }` (the service re-checks that actor from the database) → a
// refused actor (`denied`) is a 403 → revalidate the (always empty) tags →
// refresh() when the customer page shows the change.
//
// A temporary password or a copy-once invite link exists only in the value
// returned here: it is never logged, put in a URL or stored readable (plan
// Q1). The invite action does not refresh: on a filtered list the row (and
// the dialog holding the link) would vanish; the client refreshes once the
// link has been seen.

import { headers } from "next/headers";
import { refresh } from "next/cache";

import type {
  ActionData,
  ActionFailure,
  ActionResult,
} from "@/components/admin/action-result";
import type { NewInviteOutcome } from "@/components/admin/access-requests/types";
import type {
  CreateCustomerOutcome,
  TemporaryPasswordOutcome,
} from "@/components/admin/customers/types";
import {
  banCustomer,
  createCustomer,
  regenerateInvite,
  revokeCustomerSessions,
  sendCustomerResetLink,
  setCustomerAccess,
  setTemporaryPassword,
  unbanCustomer,
  updateCustomerProfile,
} from "@/lib/admin/customers";
import type { ServiceResult } from "@/lib/admin/write-result";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";

import { auditMessage, failure, inviteView } from "../action-helpers";

/*
 * Every argument is `unknown`: an action is a public POST endpoint, so the
 * browser can send anything. The services re-parse it with the same Zod
 * schemas the forms use. The actor always comes from the session.
 *
 * No try/catch: requireAdmin() works by throwing, and catching it would let
 * a non-admin call through (ADR 0024).
 */

/*
 * A failed write. One that was saved anyway (the audit entry failed) still
 * refreshes, so the page and the message agree.
 */
function failedWrite(
  result: ServiceResult<unknown> & { ok: false },
): ActionFailure {
  const answer = failure(result);
  if (answer.saved !== false) refresh();
  return answer;
}

/* The common ending of a write the customer page shows. */
function finishWrite(result: ServiceResult<unknown>): ActionResult {
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failedWrite(result);
  refresh();
  return { ok: true };
}

/**
 * Creates a customer: `{ name, email, company, country, access, delivery }`.
 * Returns the new id and what happened to the invite, including a copy-once
 * link when asked. No redirect: the link must stay in the form's memory.
 */
export async function createCustomerAction(
  input: unknown,
): Promise<ActionData<CreateCustomerOutcome>> {
  const viewer = await requireAdmin();
  const result = await createCustomer(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  const data = result.data;
  return {
    ok: true,
    data: {
      userId: data.userId,
      accessExpiresAt: data.accessExpiresAt?.toISOString() ?? null,
      invite: inviteView(data.invite),
      auditMessage: auditMessage(data.auditFailed),
    },
  };
}

/** Edits `{ userId, name, company, country }` (the email is fixed). */
export async function updateCustomerProfileAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await updateCustomerProfile(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  return finishWrite(result);
}

/**
 * Sets or extends access: `{ userId, access, notify }`. Returns the new end
 * (ISO, or null for no expiry) and whether the "extended" email went out.
 */
export async function setCustomerAccessAction(
  input: unknown,
): Promise<ActionData<{ accessExpiresAt: string | null; notified: boolean }>> {
  const viewer = await requireAdmin();
  const result = await setCustomerAccess(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failedWrite(result);
  refresh();
  return {
    ok: true,
    data: {
      accessExpiresAt: result.data.accessExpiresAt?.toISOString() ?? null,
      notified: result.data.notified,
    },
  };
}

/** Blocks `{ userId, reason }`: their sessions end at once. */
export async function banCustomerAction(input: unknown): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await banCustomer(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  return finishWrite(result);
}

/** Lifts the block on `{ userId }`. */
export async function unbanCustomerAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await unbanCustomer(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  return finishWrite(result);
}

/** Ends every session of `{ userId }`. */
export async function revokeCustomerSessionsAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await revokeCustomerSessions(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  return finishWrite(result);
}

/** Emails `{ userId }` a normal 1-hour reset link. */
export async function sendCustomerResetLinkAction(
  input: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await sendCustomerResetLink(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  return finishWrite(result);
}

/**
 * Sets a generated temporary password for `{ userId }` and returns it ONCE.
 * The customer must change it at the next sign-in; earlier links die.
 */
export async function setTemporaryPasswordAction(
  input: unknown,
): Promise<ActionData<TemporaryPasswordOutcome>> {
  const viewer = await requireAdmin();
  const result = await setTemporaryPassword(
    { id: viewer.user.id, headers: await headers() },
    input,
  );
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  // The dialog that shows the password stays mounted across the refresh.
  refresh();
  return {
    ok: true,
    data: {
      password: result.data.password,
      auditMessage: auditMessage(result.data.auditFailed),
    },
  };
}

/**
 * A new invite link for `{ userId, delivery }`: emailed, or returned once to
 * copy. Earlier links die; the access end date is untouched (plan Q1).
 */
export async function newCustomerInviteAction(
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
      auditMessage: auditMessage(result.data.auditFailed),
    },
  };
}
