// Shared session fixtures for the behavioural tests of admin Server Actions:
// the four callers that must be refused and how requireAdmin() refuses them.
// The test file still declares the vi.mock calls (they are hoisted per file);
// this holds the data they share.

/** The admin id every `signedInAs` session carries. */
export const ADMIN_USER_ID = "64b000000000000000000001";

/** A session object as getSessionFromDb returns it. */
export function sessionFor(fields: Record<string, unknown> = {}) {
  return {
    session: { id: "s1" },
    user: {
      id: ADMIN_USER_ID,
      email: "someone@example.com",
      role: "admin",
      banned: false,
      banExpires: null,
      mustChangePassword: false,
      accessExpiresAt: null,
      ...fields,
    },
  };
}

/**
 * Callers that an admin action must refuse: [label, session user fields or
 * null for no session, the error message requireAdmin() throws].
 */
export const REFUSED_CALLERS: [
  string,
  Record<string, unknown> | null,
  string,
][] = [
  ["a visitor", null, "REDIRECT /login"],
  ["a customer", { role: "customer" }, "FORBIDDEN"],
  ["a banned admin", { banned: true }, "FORBIDDEN"],
  [
    "an admin on a temporary password",
    { mustChangePassword: true },
    "REDIRECT /change-password",
  ],
];
