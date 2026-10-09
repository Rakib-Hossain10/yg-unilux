// The result every admin write service returns ({ ok, data | errors, tags })
// and the shared last step of a write: record the audit entry, and still hand
// back the cache tags when that fails, because the change is saved (ADR 0035).

import "server-only";

import { z } from "zod";

import { recordAudit, type AuditInput } from "@/lib/audit";
import type { CatalogTag } from "@/lib/revalidate";
import { OBJECT_ID_PATTERN } from "@/lib/schemas/common";

/**
 * Errors in the shape of `z.flattenError`, so a form can map `fieldErrors`
 * onto its inputs and show `formErrors` above them. Messages are safe to
 * show the admin: they never contain stack traces or database details.
 */
export interface ServiceErrors {
  formErrors: string[];
  fieldErrors: Record<string, string[]>;
}

/**
 * What an admin service returns. `tags` are the catalog cache tags the call
 * changed; the Server Action passes them to revalidateCatalogInAction() on
 * BOTH branches, because a failure after the write (the audit entry) still
 * changed data. A failure before any write has no tags.
 */
export type ServiceResult<T> =
  | { ok: true; data: T; tags: CatalogTag[] }
  | { ok: false; errors: ServiceErrors; tags: CatalogTag[] };

/** Shown when the change was saved but its audit entry was not. */
export const AUDIT_FAILED_MESSAGE =
  "The change was saved, but its audit log entry could not be written. Please tell your developer.";

/** A failure from Zod: the form's field errors, nothing written. */
export function invalidInput(error: z.ZodError): ServiceResult<never> {
  const flat = z.flattenError(error);
  return {
    ok: false,
    errors: { formErrors: flat.formErrors, fieldErrors: flat.fieldErrors },
    tags: [],
  };
}

/** A failure about one field (e.g. "slug already used"), nothing written. */
export function fieldError(
  field: string,
  message: string,
): ServiceResult<never> {
  return {
    ok: false,
    errors: { formErrors: [], fieldErrors: { [field]: [message] } },
    tags: [],
  };
}

/** A failure about the request as a whole (e.g. "not found"), nothing written. */
export function formError(...messages: string[]): ServiceResult<never> {
  return {
    ok: false,
    errors: { formErrors: messages, fieldErrors: {} },
    tags: [],
  };
}

/** A success that changed nothing, so there is nothing to audit or revalidate. */
export function unchanged<T>(data: T): ServiceResult<T> {
  return { ok: true, data, tags: [] };
}

/**
 * The actor id comes from the server session (`viewer.user.id`), never from
 * the form. A bad one is a programming error, so this throws before any
 * write instead of saving a change that could not be audited.
 */
export function assertActorId(actorId: string): void {
  if (!OBJECT_ID_PATTERN.test(actorId)) {
    throw new TypeError("Admin services need the signed-in admin's user id");
  }
}

/** True for MongoDB's duplicate-key error (code 11000) from a unique index. */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 11000
  );
}

/**
 * The last step of every successful write: record the audit entry, then
 * return the success. When the audit write fails the change stays saved
 * (ADR 0035 point 5), so this logs the failure without any values, and
 * returns an error for the admin together with the same tags.
 */
export async function auditAndFinish<T>(
  audit: AuditInput,
  data: T,
  tags: CatalogTag[],
): Promise<ServiceResult<T>> {
  try {
    await recordAudit(audit);
  } catch (error) {
    // Only the error's class name: a database message could quote values.
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(
      `[admin] audit write failed for ${audit.action} on ${audit.target.type} ${audit.target.id}: ${kind}`,
    );
    return {
      ok: false,
      errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      tags,
    };
  }
  return { ok: true, data, tags };
}

/**
 * Like auditAndFinish(), for a write whose result can't be produced again:
 * a temporary password or a copy-once invite link exists only in `data`,
 * and every earlier link is already dead. Dropping `data` on a failed audit
 * write would lose it, so this returns the success with
 * `auditFailed: true` instead (logged like auditAndFinish); the UI shows
 * AUDIT_FAILED_MESSAGE next to the result. ADR 0070's exception to ADR 0035
 * point 5.
 */
export async function auditKeepingData<T extends object>(
  audit: AuditInput,
  data: T,
  tags: CatalogTag[],
): Promise<ServiceResult<T & { auditFailed: boolean }>> {
  let auditFailed = false;
  try {
    await recordAudit(audit);
  } catch (error) {
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(
      `[admin] audit write failed for ${audit.action} on ${audit.target.type} ${audit.target.id}: ${kind}`,
    );
    auditFailed = true;
  }
  return { ok: true, data: { ...data, auditFailed }, tags };
}
