// The Better Auth session cookie's name prefix, shared by src/lib/auth.ts and
// src/proxy.ts, plus a presence check for the proxy's coarse /admin redirect.
// Kept tiny so the proxy never loads Better Auth's server, Mongoose or env.

import { getSessionCookie } from "better-auth/cookies";

/** Cookie names: yg.session_token, or __Secure-yg.session_token over https. */
export const AUTH_COOKIE_PREFIX = "yg";

/**
 * True when the request carries a session cookie. It says nothing about
 * whether the session is valid: that is only ever decided on the server by
 * requireAdmin() (ADR 0007, 0024). Used to skip a pointless page render for
 * visitors who are obviously signed out.
 */
export function hasSessionCookie(headers: Headers): boolean {
  return (
    getSessionCookie(headers, { cookiePrefix: AUTH_COOKIE_PREFIX }) !== null
  );
}
