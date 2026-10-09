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
