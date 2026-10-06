// Creates the site's admin account, or resets its password, for the
// `npm run seed:admin` CLI (CLAUDE.md "Roles": the single admin must never be
// locked out). All writes go through Better Auth; Mongoose only logs the audit entry.

import "server-only";

import { z } from "zod";

import { AuditLogModel } from "@/models/audit-log";

import { type Auth, hasRole } from "./auth";
import { clearAllForEmail } from "./rate-limit";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/*
 * 12 is our minimum (ADR 0023: createUser doesn't enforce it, so every
 * account-creating path checks it). 128 is Better Auth's default maximum
 * (maxPasswordLength), so a longer one would be refused by sign-in later.
 */
export const passwordSchema = z
  .string()
  .min(12, "The password must be at least 12 characters.")
  .max(128, "The password must be at most 128 characters.");

/* Same address rule as sign-in (z.email()), stored in lower case as Better Auth does. */
export const emailSchema = z
  .email("Enter a valid email address.")
  .max(254)
  .transform((email) => email.toLowerCase());

export const nameSchema = z
  .string()
  .trim()
  .min(1, "A name is required (--name).")
  .max(100, "The name must be at most 100 characters.");

export const seedAdminInput = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    email: emailSchema,
    name: nameSchema,
    password: passwordSchema,
  }),
  z.object({
    mode: z.literal("reset"),
    email: emailSchema,
    password: passwordSchema,
  }),
]);
export type SeedAdminInput = z.input<typeof seedAdminInput>;

/** A refusal the CLI prints as-is. Messages hold no password and no secret. */
export class SeedAdminError extends Error {
  override readonly name = "SeedAdminError";
}

export interface SeedAdminResult {
  mode: "create" | "reset";
  userId: string;
  email: string;
  /** True when a reset also lifted a ban (the admin must never stay locked out). */
  unbanned: boolean;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Creates the admin (`mode: "create"`) or resets an existing admin's password
 * (`mode: "reset"`). Expects connectDb() to have run.
 *
 * Both modes leave the account ready to sign in: `mustChangePassword: false`
 * (the password was just chosen by whoever runs the CLI, and ADR 0024's
 * requireAdmin() would otherwise send them to /change-password) and every
 * login/reset counter of the email cleared.
 *
 * A reset also ends all sessions, revokes known-device tokens (deviceEpoch,
 * ADR 0022) and lifts any ban: the same clean-up as an admin password change
 * in src/lib/auth.ts, done here directly because Better Auth's
 * setUserPassword needs a signed-in admin.
 */
export async function seedAdmin(
  auth: Auth,
  rawInput: SeedAdminInput,
): Promise<SeedAdminResult> {
  const parsed = seedAdminInput.safeParse(rawInput);
  if (!parsed.success) {
    throw new SeedAdminError(
      parsed.error.issues.map((issue) => issue.message).join("\n"),
    );
  }
  const input = parsed.data;
  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(input.email);

  if (input.mode === "create") {
    if (existing) {
      throw new SeedAdminError(
        "An account with this email already exists. To set a new admin password, run again with --reset.",
      );
    }
    const { user } = await auth.api.createUser({
      body: {
        email: input.email,
        name: input.name,
        password: input.password,
        role: "admin",
        data: { mustChangePassword: false },
      },
    });
    // Audit first: the account change is done, so it is recorded even if
    // clearing the counters fails next (QA L-3).
    await audit(user.id, "admin.cli_create");
    await clearAllForEmail(input.email);
    return {
      mode: "create",
      userId: user.id,
      email: input.email,
      unbanned: false,
    };
  }

  // Reset: only an existing admin. Never promote a customer from the CLI.
  if (!existing) {
    throw new SeedAdminError(
      "No account with this email. To create the admin, run without --reset and with --name.",
    );
  }
  // The internal adapter's type has only Better Auth's core fields; the row
  // also holds the admin plugin's and our own (ADR 0023).
  const user = existing.user as typeof existing.user & {
    role?: string | null;
    banned?: boolean | null;
    deviceEpoch?: unknown;
  };
  if (!hasRole(user, "admin")) {
    throw new SeedAdminError(
      "This account is not an admin. The CLI only resets admin passwords.",
    );
  }

  const hash = await context.password.hash(input.password);
  if (await context.internalAdapter.findCredentialAccount(user.id)) {
    await context.internalAdapter.updatePassword(user.id, hash);
  } else {
    // E.g. a create that stopped after the user row was written.
    await context.internalAdapter.createAccount({
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: hash,
    });
  }
  // Old sessions end right after the password changes, before anything
  // else can fail and leave them alive.
  await context.internalAdapter.deleteUserSessions(user.id);

  const wasBanned = user.banned === true;
  const epoch = user.deviceEpoch;
  await context.internalAdapter.updateUser(user.id, {
    mustChangePassword: false,
    banned: false,
    banReason: null,
    banExpires: null,
    deviceEpoch:
      (typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0
        ? epoch
        : 0) + 1,
  });
  await audit(user.id, "admin.cli_reset_password", { unbanned: wasBanned });
  await clearAllForEmail(input.email);
  return {
    mode: "reset",
    userId: user.id,
    email: input.email,
    unbanned: wasBanned,
  };
}

/*
 * One audit entry per CLI change. The actor is the admin account itself: the
 * CLI has no signed-in user, and whoever runs it holds the database
 * credentials. Never includes the password.
 */
async function audit(
  userId: string,
  action: "admin.cli_create" | "admin.cli_reset_password",
  meta: Record<string, unknown> = {},
): Promise<void> {
  await AuditLogModel.create({
    actor: userId,
    action,
    target: { type: "user", id: userId },
    meta: { via: "cli", ...meta },
  });
}
