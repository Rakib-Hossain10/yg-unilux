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
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

/**
 * Entries written outside the admin panel, by Phase 1 code:
 * - `auth.rate_limited`: an anonymous sign-in lockout (src/lib/auth.ts), the
 *   only kind of entry allowed without an actor;
 * - `admin.cli_*`: the seed-admin CLI creating the admin or resetting its
 *   password (src/lib/seed-admin.ts).
 */
export const SYSTEM_AUDIT_ACTIONS = [
  "auth.rate_limited",
  "admin.cli_create",
  "admin.cli_reset_password",
] as const;
export type SystemAuditAction = (typeof SYSTEM_AUDIT_ACTIONS)[number];

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
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];
