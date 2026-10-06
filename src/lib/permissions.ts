// Server-side access checks (CLAUDE.md "Security rules" 2, 3 and 9): who may
// enter /admin, who may download datasheets and who may see restricted specs.
// Every check reads the session from the database, never a cookie cache.

import "server-only";

import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { cache } from "react";

import { getSessionFromDb, hasRole } from "./auth";

// ---------------------------------------------------------------------------
// Pure rules (no request, no database: unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * The user fields the rules need. Better Auth's session user has them all
 * (admin plugin: role/banned/banExpires; our additionalFields:
 * mustChangePassword/accessExpiresAt). Dates arrive as Date objects from the
 * MongoDB adapter; strings are accepted in case a cache ever serialises them.
 */
export interface AccessUser {
  id: string;
  role?: string | null;
  banned?: boolean | null;
  banExpires?: Date | string | null;
  mustChangePassword?: boolean | null;
  accessExpiresAt?: Date | string | null;
}

/* A date field as epoch ms; NaN when present but unreadable. */
function timeOf(value: Date | string): number {
  return new Date(value).getTime();
}

/**
 * True while a ban is in force. Better Auth ends a timed ban by itself once
 * `banExpires` has passed (it unbans on the next sign-in), so an expired ban
 * no longer counts. An unreadable `banExpires` counts as banned (fail closed).
 */
export function isBanned(user: AccessUser, now: Date): boolean {
  if (user.banned !== true) return false;
  if (user.banExpires == null) return true;
  const until = timeOf(user.banExpires);
  return Number.isNaN(until) || until > now.getTime();
}

/**
 * True unless the password change is known to be done. Only an explicit
 * `false` counts as changed: a missing or odd value (legacy row, raw insert,
 * import bug) fails closed (QA L1, task 6).
 */
export function needsPasswordChange(user: AccessUser): boolean {
  return user.mustChangePassword !== false;
}

/** An admin who isn't banned. A pending password change is handled by callers. */
export function isActiveAdmin(user: AccessUser, now: Date): boolean {
  return hasRole(user, "admin") && !isBanned(user, now);
}

/*
 * True when datasheet access has run out. null/undefined = no expiry. An
 * unreadable date counts as expired (fail closed). The admin has no expiry.
 */
function accessExpired(user: AccessUser, now: Date): boolean {
  if (user.accessExpiresAt == null) return false;
  const until = timeOf(user.accessExpiresAt);
  return Number.isNaN(until) || until <= now.getTime();
}

/** Why a datasheet download (or restricted data) is refused. */
export type AccessDenial =
  "signed-out" | "not-allowed" | "banned" | "must-change-password" | "expired";

export type DatasheetAccess =
  { ok: true; user: AccessUser } | { ok: false; reason: AccessDenial };

/**
 * The datasheet rule (security rule 2), in order: signed in → admin or
 * customer → not banned → password already changed → access not expired.
 * A temporary password (mustChangePassword) unlocks nothing until it is
 * changed, so an intercepted welcome password can't download anything.
 * The admin skips only the expiry step.
 */
export function checkDatasheetAccess(
  user: AccessUser | null | undefined,
  now: Date,
): DatasheetAccess {
  if (!user) return { ok: false, reason: "signed-out" };
  const admin = hasRole(user, "admin");
  if (!admin && !hasRole(user, "customer")) {
    return { ok: false, reason: "not-allowed" };
  }
  if (isBanned(user, now)) return { ok: false, reason: "banned" };
  if (needsPasswordChange(user)) {
    return { ok: false, reason: "must-change-password" };
  }
  if (!admin && accessExpired(user, now)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, user };
}

/**
 * Restricted spec values (rule 9) go to the same people who may download
 * datasheets: an active, unexpired customer or the admin.
 */
export function canSeeRestricted(
  user: AccessUser | null | undefined,
  now: Date,
): boolean {
  return checkDatasheetAccess(user, now).ok;
}

// ---------------------------------------------------------------------------
// Request helpers (Server Components, Server Actions, Route Handlers)
// ---------------------------------------------------------------------------

/** The signed-in user and session, as Better Auth returns them. */
export type Viewer = NonNullable<Awaited<ReturnType<typeof getSessionFromDb>>>;

/**
 * The current viewer, read from the sessions collection, or null when
 * signed out. Wrapped in React `cache` so a layout, a page and the
 * restricted-specs block share ONE database read per request. A database
 * failure is thrown, never turned into "signed out" or "allowed".
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  return getSessionFromDb(await headers());
});

/** Where a signed-out visitor is sent, and where a temporary password is changed. */
export const LOGIN_PATH = "/login";
export const CHANGE_PASSWORD_PATH = "/change-password";

/**
 * Guard for every admin page and Server Action (rule 3). Signed out →
 * redirect to the login page; still on a temporary password → redirect to
 * change it; signed in but not an active admin → 403 via `forbidden()`
 * (needs `experimental.authInterrupts`, ADR 0024). Returns the viewer.
 * Must be awaited in the render path or the action body: it works by throwing.
 * Never call it inside try/catch without `unstable_rethrow`, or the
 * redirect/403 is swallowed and the action runs as if allowed.
 */
export async function requireAdmin(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(LOGIN_PATH);
  if (!isActiveAdmin(viewer.user, new Date())) forbidden();
  if (needsPasswordChange(viewer.user)) redirect(CHANGE_PASSWORD_PATH);
  return viewer;
}

/* JSON answers for API callers; never cached by a browser or CDN. */
function jsonError(status: 401 | 403, message: string): Response {
  return Response.json(
    { message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export type AdminRouteCheck =
  { ok: true; viewer: Viewer } | { ok: false; response: Response };

/**
 * Guard for admin Route Handlers (rule 3). Same rules as requireAdmin(), but
 * answers with a JSON 401/403 instead of a redirect, because a redirect to
 * an HTML login page would look like success to fetch().
 */
export async function requireAdminForRoute(): Promise<AdminRouteCheck> {
  const viewer = await getViewer();
  if (!viewer) {
    return { ok: false, response: jsonError(401, "Sign in required.") };
  }
  if (
    !isActiveAdmin(viewer.user, new Date()) ||
    needsPasswordChange(viewer.user)
  ) {
    return { ok: false, response: jsonError(403, "Not allowed.") };
  }
  return { ok: true, viewer };
}

/**
 * Datasheet-route check (rule 2) for the current request. Returns a result
 * instead of throwing so /api/datasheet/[productId] can answer each reason
 * with its own status and message ("Access expired — contact us").
 */
export async function requireCustomerAccess(): Promise<DatasheetAccess> {
  const viewer = await getViewer();
  return checkDatasheetAccess(viewer?.user, new Date());
}

/**
 * For the uncached restricted-specs block (ADR 0002) only. Cached catalog
 * code must never call this: it reads the request's session.
 */
export async function viewerCanSeeRestricted(): Promise<boolean> {
  const viewer = await getViewer();
  return canSeeRestricted(viewer?.user, new Date());
}
