// The one list of audit log actions. The auditLog schema uses it as its enum
// and src/lib/audit.ts validates admin writes against it. No imports, so the
// model and the helper can both use it without a circular import.

/**
 * Admin panel writes, named `<entity>.<verb>` (Phase 2 plan). Every admin
 * service records exactly one of these per successful write, through
 * `recordAudit()` in src/lib/audit.ts.
 */
export const ADMIN_AUDIT_ACTIONS = [
  "product.create",
  "product.update",
  "product.delete",
  "product.publish",
  "product.unpublish",
  "product.images.update",
  "product.datasheet.attach",
  "product.datasheet.detach",
  "category.create",
  "category.update",
  "category.delete",
  "category.reorder",
  "area.create",
  "area.update",
  "area.delete",
  "area.reorder",
  "datasheet.upload",
  "datasheet.replace",
  "datasheet.rename",
  "datasheet.delete",
  "settings.columns.update",
  "settings.whatsapp.update",
  "settings.email.update",
  // One entry per committed import batch (Phase 3); target = the staged file.
  "import.commit",
  // Phase 5 (ADR 0069): the access-request queue. target = the request.
  "access_request.approve",
  "access_request.reject",
  "access_request.create_manual",
  "access_request.delete",
  // Phase 5 (ADR 0070): customer accounts. target = the customer's user id.
  "customer.create",
  "customer.update",
  "customer.access.set",
  "customer.ban",
  "customer.unban",
  "customer.password.link",
  "customer.password.temp",
  "customer.sessions.revoke",
  "customer.invite.resend",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/**
 * Entries written outside the admin panel:
 * - `auth.rate_limited`: an anonymous sign-in lockout (src/lib/auth.ts);
 * - `admin.cli_*`: the seed-admin CLI creating the admin or resetting its
 *   password (src/lib/seed-admin.ts);
 * - `cron.expiry_reminders`: one entry per daily expiry-reminder run
 *   (Phase 5 P5), counts only.
 * Only `auth.*` and `cron.*` entries may have no actor
 * (ACTORLESS_AUDIT_PREFIXES).
 */
export const SYSTEM_AUDIT_ACTIONS = [
  "auth.rate_limited",
  "admin.cli_create",
  "admin.cli_reset_password",
  "cron.expiry_reminders",
] as const;
export type SystemAuditAction = (typeof SYSTEM_AUDIT_ACTIONS)[number];

/** Action prefixes written with no signed-in actor (security events, cron). */
export const ACTORLESS_AUDIT_PREFIXES = ["auth.", "cron."] as const;

/** Every action the auditLog collection accepts. */
export const AUDIT_ACTIONS = [
  ...ADMIN_AUDIT_ACTIONS,
  ...SYSTEM_AUDIT_ACTIONS,
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** What an admin audit entry can be about; the action's first word must match. */
export const AUDIT_TARGET_TYPES = [
  "product",
  "category",
  "area",
  "datasheet",
  "settings",
  /** A bulk import run, addressed by its staged file's uuid (imports/<uuid>.xlsx). */
  "import",
  /** An accessRequests document (Phase 5). */
  "access_request",
  /** A customer account, addressed by its Better Auth user id (Phase 5). */
  "customer",
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];
