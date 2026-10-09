// The ONE place that writes our own fields on Better Auth's users
// (mustChangePassword, accessExpiresAt, company, country, deviceEpoch and the
// Phase 5 invite/password dates) and deletes a user's reset/invite links.

import "server-only";

import type { AuthContext } from "better-auth";
import { z } from "zod";

/*
 * Why a module of its own (Phase 5 plan, "Writes to users"):
 * - Better Auth owns `users`; Mongoose never writes it (src/models/user.ts
 *   throws). Our fields are `input: false`, so no public endpoint can set
 *   them either (dist/db/schema.mjs:65-77 refuses them).
 * - `auth.api.adminUpdateUser` WOULD write them: it hands `body.data`
 *   straight to internalAdapter.updateUser without parseUserInput
 *   (plugins/admin/routes.mjs:257, 304). But it needs a signed-in admin's
 *   headers, so the after-hooks, the cron and the CLI couldn't use it.
 * - So every write goes through `internalAdapter.updateUser` here, behind a
 *   strict Zod allowlist. account-writes.guard.test.ts keeps it the only
 *   caller in src/.
 * - Better Auth's adapter silently DROPS keys that are not declared in
 *   `user.additionalFields` (@better-auth/core/dist/db/adapter/factory.mjs
 *   :104-115). Every field below must be declared in src/lib/auth.ts;
 *   account-writes.test.ts reads each one back from the raw document.
 */

/** One condition of a Better Auth adapter query (the subset used here). */
interface WhereClause {
  field: string;
  value: string | Date;
  operator?: "lt" | "ne";
}

/**
 * The parts of Better Auth's context this module uses: from a hook
 * (`ctx.context`) or `await auth.$context`. Structural, because the
 * adapter's generic options type makes the full AuthContext invariant.
 */
export interface AccountContext {
  internalAdapter: Pick<
    AuthContext["internalAdapter"],
    "findUserById" | "updateUser"
  >;
  adapter: {
    deleteMany(data: { model: string; where: WhereClause[] }): Promise<number>;
  };
}

/** A user id as the MongoDB adapter hands it out: 24 hex characters. */
export const userIdSchema = z.string().regex(/^[0-9a-f]{24}$/);

/* Free-text profile fields: one line, trimmed, capped. */
const profileText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\r\n\t\x00-\x1f\x7f]*$/)
    .nullable();

/* A real date; an Invalid Date would be stored as null by the driver. */
const validDate = z.date().refine((d) => !Number.isNaN(d.getTime()));

/**
 * The fields callers (invite.ts, the P3 customer services, the P5 cron) may
 * set. deviceEpoch is NOT here: it only ever moves up, through
 * recordPasswordSet() and bumpDeviceEpoch().
 */
export const accountFieldsSchema = z
  .object({
    mustChangePassword: z.boolean(),
    /** End of datasheet access (end of a UTC day, plan Q5); null = no expiry. */
    accessExpiresAt: validDate.nullable(),
    company: profileText(200),
    country: profileText(100),
    /** The accessExpiresAt value the last 7-day reminder was sent for (P5). */
    expiryReminderFor: validDate.nullable(),
    /** When the latest invite link was made; null = never invited. */
    invitedAt: validDate.nullable(),
    /** When that link stops working (invitedAt + 72 h). */
    inviteExpiresAt: validDate.nullable(),
    /** When the user last chose their own password (reset, invite or change). */
    passwordSetAt: validDate.nullable(),
  })
  .partial()
  .strict()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "nothing to update",
  );
export type AccountFields = z.input<typeof accountFieldsSchema>;

/**
 * A write was refused or found no user. The message names only the reason,
 * never an email, token or field value.
 */
export class AccountWriteError extends Error {
  override readonly name = "AccountWriteError";
  constructor(readonly reason: "invalid_input" | "user_not_found") {
    super(`Account not updated: ${reason}`);
  }
}

/**
 * A user's device epoch; missing or malformed counts as 0. Shared with the
 * sign-in gate in auth.ts, so tokens are issued and checked the same way.
 */
export function epochOf(user: unknown): number {
  const value =
    typeof user === "object" && user !== null
      ? (user as { deviceEpoch?: unknown }).deviceEpoch
      : undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/* Validates the id (ids come from forms and URLs in P3). Every exported
 * function runs it first, so "" or a malformed id never reaches a query. */
function parseUserId(userId: string): string {
  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) throw new AccountWriteError("invalid_input");
  return parsed.data;
}

/**
 * Sets some of our fields on one user. Throws AccountWriteError on a bad
 * patch or an unknown user; database errors are thrown as they are.
 */
export async function updateAccountFields(
  context: AccountContext,
  userId: string,
  patch: AccountFields,
): Promise<void> {
  const id = parseUserId(userId);
  const parsed = accountFieldsSchema.safeParse(patch);
  if (!parsed.success) throw new AccountWriteError("invalid_input");
  const updated = await context.internalAdapter.updateUser(id, parsed.data);
  if (!updated) throw new AccountWriteError("user_not_found");
}

/**
 * Bumps the user's device epoch, so every known-device token issued before
 * stops verifying (ADR 0022 QA L1). Returns the new epoch, or null when the
 * user doesn't exist. A read-then-write: two bumps racing both move the
 * epoch away from its old value, so every token issued BEFORE either is
 * dead. Known limit (ADR 0068): a token issued by one racer for N+1 can
 * survive the other racer's bump to the same N+1. The device token only
 * picks the sign-in rate-limit path (ADR 0022), so this is accepted.
 */
export async function bumpDeviceEpoch(
  context: AccountContext,
  userId: string,
): Promise<number | null> {
  const id = parseUserId(userId);
  const user = await context.internalAdapter.findUserById(id);
  if (!user) return null;
  const next = epochOf(user) + 1;
  const updated = await context.internalAdapter.updateUser(id, {
    deviceEpoch: next,
  });
  return updated ? next : null;
}

/**
 * The user just chose their own password (change-password, a reset or an
 * invite link). ONE write clears mustChangePassword, stamps passwordSetAt
 * and bumps the device epoch, so the flag can never be cleared while old
 * device tokens stay valid, or the other way round. Returns the new epoch,
 * or null when the user doesn't exist.
 */
export async function recordPasswordSet(
  context: AccountContext,
  userId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const id = parseUserId(userId);
  const user = await context.internalAdapter.findUserById(id);
  if (!user) return null;
  const next = epochOf(user) + 1;
  const updated = await context.internalAdapter.updateUser(id, {
    mustChangePassword: false,
    passwordSetAt: now,
    deviceEpoch: next,
  });
  return updated ? next : null;
}

/**
 * `seed:admin --reset` (src/lib/seed-admin.ts): the password was just chosen
 * on the CLI, so the admin must not be sent to /change-password; any ban is
 * lifted (the single admin must never stay locked out) and old device
 * tokens die. One write.
 */
export async function recoverAdminFromCli(
  context: AccountContext,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const id = parseUserId(userId);
  const user = await context.internalAdapter.findUserById(id);
  if (!user) throw new AccountWriteError("user_not_found");
  const updated = await context.internalAdapter.updateUser(id, {
    mustChangePassword: false,
    passwordSetAt: now,
    banned: false,
    banReason: null,
    banExpires: null,
    deviceEpoch: epochOf(user) + 1,
  });
  if (!updated) throw new AccountWriteError("user_not_found");
}

/**
 * Deletes the user's password links: every `verifications` row whose value
 * is the user id. With our configuration those are exactly the reset and
 * invite tokens (`reset-password:<token>`, value = user id,
 * dist/api/routes/password.mjs:75-79). Every other flow that would write
 * such rows (email verification, change-email, delete-user, OTP plugins) is
 * disabled (DISABLED_PATHS) or not installed. Identifiers are stored hashed
 * (`storeIdentifier: "hashed"`), so the value is the only way to find them.
 *
 * `except` keeps one row by id (the link invite.ts just created). Matching
 * by id, not by time, means a row created in the same millisecond is still
 * deleted.
 */
export async function revokePasswordLinks(
  context: AccountContext,
  userId: string,
  options: { except?: string } = {},
): Promise<void> {
  const id = parseUserId(userId);
  const where: WhereClause[] = [{ field: "value", value: id }];
  if (options.except !== undefined) {
    where.push({ field: "id", value: options.except, operator: "ne" });
  }
  await context.adapter.deleteMany({ model: "verification", where });
}
