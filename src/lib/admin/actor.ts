// The admin a P3 service runs as (ADR 0069/0070, QA gate A M-1): the
// signed-in admin's user id and request headers. Every read and write in
// src/lib/admin/customers.ts and access-requests.ts re-checks, from the
// database, that those headers belong to an active admin with that id. It
// is the second line behind the Server Action's requireAdmin() (rule 3), so
// one action that forgets requireAdmin() can't hand a customer an admin
// service.

import "server-only";

import { getSessionFromDb } from "@/lib/auth";
import { isActiveAdmin, needsPasswordChange } from "@/lib/permissions";

import {
  assertActorId,
  type AdminActorRefusal,
  type ServiceResult,
} from "./write-result";

export type { AdminActorRefusal };

/**
 * The verified admin a service runs as: the session's user id and the
 * request's headers (`await headers()` in the Server Action).
 */
export interface AdminActor {
  id: string;
  headers: Headers;
}

/**
 * Thrown by assertAdminActor() when the actor is not the signed-in active
 * admin. Read services let it propagate (the page maps it to `forbidden()`);
 * write services turn it into a `{ ok: false, denied }` result.
 */
export class AdminActorError extends Error {
  readonly reason: AdminActorRefusal;

  constructor(reason: AdminActorRefusal) {
    super(`Admin services refused the actor: ${reason}`);
    this.name = "AdminActorError";
    this.reason = reason;
  }
}

/** Shape check only (a programming error throws a TypeError). */
export function assertActor(actor: AdminActor): void {
  assertActorId(actor.id);
  if (!(actor.headers instanceof Headers)) {
    throw new TypeError("Admin services need the admin's request headers");
  }
}

/**
 * Reads the session behind `actor.headers` from the database (never a
 * cookie cache) and requires: a session, an active (not banned) admin, the
 * password change done, and the session's user id equal to `actor.id`.
 * Throws AdminActorError otherwise; a database failure is thrown as is.
 */
export async function assertAdminActor(
  actor: AdminActor,
  now: Date = new Date(),
): Promise<void> {
  assertActor(actor);
  const session = await getSessionFromDb(actor.headers);
  if (!session) throw new AdminActorError("signed_out");
  if (!isActiveAdmin(session.user, now)) throw new AdminActorError("not_admin");
  if (needsPasswordChange(session.user)) {
    throw new AdminActorError("must_change_password");
  }
  if (session.user.id !== actor.id) {
    throw new AdminActorError("actor_mismatch");
  }
}

/** The one message a refused actor sees; never says why. */
export const ACTOR_REFUSED_MESSAGE = "You are not allowed to do this.";
const TRY_AGAIN = "Something went wrong. Please try again.";

/**
 * For write services: null when the actor is the signed-in admin, else the
 * failure to return as is (nothing written). A refusal carries `denied`
 * (the P7/P8 action maps it to `forbidden()`); a database failure while
 * reading the session is the generic "try again", logged by type only.
 */
export async function refuseUnlessAdmin(
  actor: AdminActor,
  scope: string,
): Promise<ServiceResult<never> | null> {
  assertActor(actor); // a programming error throws, outside the catch
  try {
    await assertAdminActor(actor);
    return null;
  } catch (error) {
    if (error instanceof AdminActorError) {
      console.warn(`[${scope}] actor refused: ${error.reason}`);
      return {
        ok: false,
        errors: { formErrors: [ACTOR_REFUSED_MESSAGE], fieldErrors: {} },
        tags: [],
        denied: error.reason,
      };
    }
    const kind = error instanceof Error ? error.name : typeof error;
    console.error(`[${scope}] actor not checked: ${kind}`);
    return {
      ok: false,
      errors: { formErrors: [TRY_AGAIN], fieldErrors: {} },
      tags: [],
    };
  }
}
