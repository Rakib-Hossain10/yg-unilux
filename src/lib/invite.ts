// Invite links (plan Q1): a "Set your password" link valid 72 hours, built on
// Better Auth's own reset tokens, plus the pure status the admin screens
// show ("Invite pending until …" / "Invite expired" / accepted).

import "server-only";

import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  AccountWriteError,
  revokePasswordLinks,
  updateAccountFields,
  userIdSchema,
} from "./account-writes";
import { getAuthContext, hasRole } from "./auth";
import { INVITE_TOKEN_TTL_SECONDS } from "./email";
import { env } from "./env";

/*
 * How it works (spike, better-auth 1.7.7):
 * - /request-password-reset stores a `verifications` row with identifier
 *   `reset-password:<token>`, value = user id and its own expiresAt
 *   (dist/api/routes/password.mjs:73-79). We create the same row through
 *   internalAdapter.createVerificationValue, which hashes the identifier
 *   with SHA-256 because of `storeIdentifier: "hashed"`
 *   (dist/db/internal-adapter.mjs:701-717, dist/db/verification-token-
 *   storage.mjs:4-13), exactly as the reset route does.
 * - POST /api/auth/reset-password consumes `reset-password:<token>`
 *   atomically (single use) and refuses an expired row
 *   (password.mjs:154-156, internal-adapter.mjs:787-857). It never looks at
 *   how the row was made, so a 72 h row works like a 1 h one, and our
 *   after-hook clears mustChangePassword for both.
 * - Identifiers are hashed, so earlier links can't be found by prefix. They
 *   are found by value (= user id): see revokePasswordLinks().
 */

/** Path of the page that reads the token (built in P2). */
export const RESET_PASSWORD_PAGE_PATH = "/reset-password";

/** A new invite could not be made. Holds no email, token or URL. */
export class InviteError extends Error {
  override readonly name = "InviteError";
  constructor(readonly reason: "user_not_found" | "not_a_customer") {
    super(`Invite not created: ${reason}`);
  }
}

/** What the admin gets back. `url` is a credential: never log or store it. */
export interface InviteLink {
  url: string;
  expiresAt: Date;
}

/**
 * Makes a new 72-hour invite link for a customer and kills every earlier
 * one. Steps, in this order:
 * 1. a fresh single-use token (32 random bytes, base64url) stored as a
 *    Better Auth reset row (hashed);
 * 2. every OTHER reset/invite row of the user is deleted, so only the new
 *    link works (a pending 1 h forgot-password link dies too);
 * 3. invitedAt / inviteExpiresAt are written on the user (for the status).
 * If step 2 or 3 fails, the error is thrown and the link is never returned,
 * so nobody holds it; the admin simply retries.
 *
 * Not safe to run twice at once for the same user: each call deletes the
 * other's row, so a double-click can hand out a link that is already dead
 * (never two live links). The P3 caller disables the button while pending
 * and rate-limits per customer.
 *
 * Refuses an unknown user and an admin account (invites are for customers;
 * the admin recovers through /forgot-password or the CLI). Does NOT touch
 * accessExpiresAt (plan Q1: regenerating never extends access) nor
 * mustChangePassword. Rate limiting and auditing belong to the P3 caller.
 */
export async function createInviteLink(
  userId: string,
  options: { now?: Date } = {},
): Promise<InviteLink> {
  const id = z.string().pipe(userIdSchema).safeParse(userId);
  if (!id.success) throw new AccountWriteError("invalid_input");
  const context = await getAuthContext();
  const user = await context.internalAdapter.findUserById(id.data);
  if (!user) throw new InviteError("user_not_found");
  // Customers only, failing closed on a missing or unknown role.
  const role = user as { role?: string | null };
  if (!hasRole(role, "customer") || hasRole(role, "admin")) {
    throw new InviteError("not_a_customer");
  }

  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TOKEN_TTL_SECONDS * 1000);
  const token = randomBytes(32).toString("base64url");
  const created = await context.internalAdapter.createVerificationValue({
    value: id.data,
    identifier: `reset-password:${token}`,
    // Better Auth accepts a row while `expiresAt >= now` (it refuses only
    // `expiresAt < now`); one millisecond less makes "valid" mean exactly
    // `now < inviteExpiresAt`, the same rule as inviteStatus().
    expiresAt: new Date(expiresAt.getTime() - 1),
  });
  await revokePasswordLinks(context, id.data, { except: created.id });
  await updateAccountFields(context, id.data, {
    invitedAt: now,
    inviteExpiresAt: expiresAt,
  });

  return { url: inviteUrl(token), expiresAt };
}

/*
 * `${AUTH_URL}/reset-password?token=<token>&invite=1`: the same-origin page
 * P2 builds. The page reads `token` (and shows "Set your password" wording
 * when `invite=1`) and posts it with the new password to
 * /api/auth/reset-password. AUTH_URL is a fixed origin (env.ts), never the
 * request's Host header.
 */
function inviteUrl(token: string): string {
  const url = new URL(RESET_PASSWORD_PAGE_PATH, env.auth().url);
  url.searchParams.set("token", token);
  url.searchParams.set("invite", "1");
  return url.href;
}

/** The user fields inviteStatus() reads (UserModel lean docs have them). */
export interface InviteFields {
  invitedAt?: Date | string | null;
  inviteExpiresAt?: Date | string | null;
  passwordSetAt?: Date | string | null;
}

export type InviteStatus =
  | { state: "none" }
  | { state: "pending"; until: Date }
  | { state: "expired"; expiredAt: Date | null }
  | { state: "accepted" };

/* A stored date as a Date; null when missing or unreadable. */
function dateOf(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The invite's status at `now`, from the user's fields alone (pure):
 * - "none": never invited (e.g. created with a temporary password);
 * - "accepted": the user chose a password at or after the latest invite
 *   (through the invite, /forgot-password or /change-password);
 * - "pending" until inviteExpiresAt, while `now < inviteExpiresAt`;
 * - "expired" from inviteExpiresAt on, or when the expiry is missing or
 *   unreadable (fail closed: the admin is told to send a new one).
 */
export function inviteStatus(user: InviteFields, now: Date): InviteStatus {
  const invitedAt = dateOf(user.invitedAt);
  if (!invitedAt) return { state: "none" };
  const passwordSetAt = dateOf(user.passwordSetAt);
  if (passwordSetAt && passwordSetAt.getTime() >= invitedAt.getTime()) {
    return { state: "accepted" };
  }
  const until = dateOf(user.inviteExpiresAt);
  if (until && now.getTime() < until.getTime()) {
    return { state: "pending", until };
  }
  return { state: "expired", expiredAt: until };
}
