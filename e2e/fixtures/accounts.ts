// Test-only accounts for the Playwright suite, seeded by e2e/test-server.ts
// into a throwaway in-memory database. Never used against a real database.

export const E2E_ADMIN = {
  email: "e2e-admin@example.com",
  name: "E2E Admin",
  password: "e2e-admin-password-1",
} as const;

/**
 * A customer only the email specs use (reset and invite links), so their
 * reset requests never spend the per-email limit of E2E_CUSTOMER, whose
 * signed-in state other specs share.
 */
export const E2E_MAIL_CUSTOMER = {
  email: "e2e-mail-customer@example.com",
  name: "E2E Mail Customer",
  password: "e2e-mail-customer-password-1",
} as const;

export const E2E_CUSTOMER = {
  email: "e2e-customer@example.com",
  name: "E2E Customer",
  password: "e2e-customer-password-1",
} as const;

/**
 * Phase 5 P2 account pages (e2e/account-pages.spec.ts). Each flow that
 * changes a password or signs in repeatedly has its own account, so specs
 * never change another spec's password or spend its sign-in budget.
 */

/** Still on its temporary password: forced through /change-password. */
export const E2E_TEMP_CUSTOMER = {
  email: "e2e-temp-customer@example.com",
  name: "E2E Temp Customer",
  password: "e2e-temp-customer-password-1",
} as const;

/** Password already chosen, access until E2E_READY_ACCESS_UNTIL. */
export const E2E_READY_CUSTOMER = {
  email: "e2e-ready-customer@example.com",
  name: "E2E Ready Customer",
  password: "e2e-ready-customer-password-1",
} as const;

/** End of a UTC day, far enough ahead to stay active in any run. */
export const E2E_READY_ACCESS_UNTIL = new Date("2099-03-31T23:59:59.999Z");

/** Password already chosen, access ended on E2E_EXPIRED_ACCESS_ENDED. */
export const E2E_EXPIRED_CUSTOMER = {
  email: "e2e-expired-customer@example.com",
  name: "E2E Expired Customer",
  password: "e2e-expired-customer-password-1",
} as const;

export const E2E_EXPIRED_ACCESS_ENDED = new Date("2026-01-31T23:59:59.999Z");

/** Every customer e2e/test-server.ts seeds (the admin dashboard count). */
export const E2E_SEEDED_CUSTOMERS = [
  E2E_CUSTOMER,
  E2E_MAIL_CUSTOMER,
  E2E_TEMP_CUSTOMER,
  E2E_READY_CUSTOMER,
  E2E_EXPIRED_CUSTOMER,
] as const;
