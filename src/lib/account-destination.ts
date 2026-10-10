// Where a signed-in user goes from /login, after sign-in and after a password
// change (Phase 5 plan Q7, ADR 0068). Pure: no request, no env, no server-only
// import, so the login form (browser) and the account pages (server) share
// the exact same rule.

import { safeNextPath } from "./safe-next-path";

export const LOGIN_PAGE = "/login";
export const CHANGE_PASSWORD_PAGE = "/change-password";
export const FORGOT_PASSWORD_PAGE = "/forgot-password";
export const RESET_PASSWORD_PAGE = "/reset-password";
export const MY_DOWNLOADS_PAGE = "/my-downloads";
export const ADMIN_HOME = "/admin";

/*
 * Pages a `next` may never point at: the auth pages themselves (a signed-in
 * user on /login is sent on, so next=/login would loop; the password pages
 * are reached through their own flows) and API routes (a JSON answer is not
 * a destination).
 */
const NEVER_NEXT = [
  LOGIN_PAGE,
  CHANGE_PASSWORD_PAGE,
  FORGOT_PASSWORD_PAGE,
  RESET_PASSWORD_PAGE,
  "/api",
] as const;

/* The path part of a same-origin path ("/a/b?x#y" → "/a/b"). */
function pathnameOf(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/**
 * A `?next=` value that may be used as a destination: same-origin
 * (safeNextPath) and not an auth page or API route. Anything else → null,
 * and the caller falls back to its default page. Accepts `unknown`, so a
 * repeated query parameter (an array) is refused too.
 */
export function accountNextPath(raw: unknown): string | null {
  const safe = safeNextPath(raw);
  if (!safe) return null;
  const pathname = pathnameOf(safe);
  const blocked = NEVER_NEXT.some(
    (page) => pathname === page || pathname.startsWith(`${page}/`),
  );
  return blocked ? null : safe;
}

/** The fields the rule reads from a Better Auth user. */
export interface DestinationUser {
  role?: unknown;
  mustChangePassword?: unknown;
}

/* Better Auth's admin plugin joins several roles with ",". */
function isAdmin(role: unknown): boolean {
  return (
    typeof role === "string" &&
    role
      .split(",")
      .map((part) => part.trim())
      .includes("admin")
  );
}

/** `/change-password`, carrying a safe `next` on to after the change. */
export function changePasswordPathFor(next: string | null): string {
  return next
    ? `${CHANGE_PASSWORD_PAGE}?${new URLSearchParams({ next }).toString()}`
    : CHANGE_PASSWORD_PAGE;
}

/**
 * The Q7 rule, in order:
 * 1. still on a temporary password → `/change-password` (keeping `next`).
 *    Only an explicit `false` counts as changed (fail closed, like
 *    permissions.needsPasswordChange);
 * 2. admin → `/admin`;
 * 3. anyone else → the safe `next`, else `/my-downloads`.
 * `rawNext` is checked here, so callers may pass the query value as is.
 */
export function destinationAfterSignIn(
  user: DestinationUser,
  rawNext?: unknown,
): string {
  const next = accountNextPath(rawNext);
  if (user.mustChangePassword !== false) return changePasswordPathFor(next);
  if (isAdmin(user.role)) return ADMIN_HOME;
  return next ?? MY_DOWNLOADS_PAGE;
}

/**
 * Where /change-password sends the user once the change succeeded: the same
 * rule with the flag cleared (the server's after-hook clears it in the same
 * request).
 */
export function destinationAfterPasswordChange(
  user: Pick<DestinationUser, "role">,
  rawNext?: unknown,
): string {
  return destinationAfterSignIn(
    { role: user.role, mustChangePassword: false },
    rawNext,
  );
}

/**
 * A search param given exactly once. Next hands a repeated parameter over as
 * an array; that is refused (undefined) rather than guessing which to use.
 */
export function singleParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? undefined : value;
}
