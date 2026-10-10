// The admin a P3/P8 read service runs as, for admin pages (ADR 0073): the
// signed-in admin's id and this request's headers. The service re-checks
// them from the database and throws AdminActorError when they are not an
// active admin; the page answers that with a 403, like requireAdmin().
// Call only after `await requireAdmin()`.

import "server-only";

import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import { AdminActorError, type AdminActor } from "@/lib/admin/actor";
import type { Viewer } from "@/lib/permissions";

/** The actor for a page: `{ id: viewer.user.id, headers: await headers() }`. */
export async function pageActor(viewer: Viewer): Promise<AdminActor> {
  return { id: viewer.user.id, headers: await headers() };
}

/**
 * Runs an admin read; a refused actor becomes `forbidden()`. Any other
 * error (a database failure) is thrown on to the admin error page. Takes a
 * function, so the read starts inside the try.
 */
export async function readAsAdmin<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AdminActorError) forbidden();
    throw error;
  }
}
