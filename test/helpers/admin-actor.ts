// Admin actors for service tests that don't run Better Auth (ADR 0073): each
// actor carries a test header that `fakeSessionFromDb` maps back to a session
// user with the fields the actor check reads. The test file wires it in
// itself (vi.mock is hoisted per file):
//
//   vi.mock("@/lib/auth", async (importOriginal) => ({
//     ...(await importOriginal<typeof import("@/lib/auth")>()),
//     getSessionFromDb: (await import("<path>/test/helpers/admin-actor"))
//       .fakeSessionFromDb,
//   }));
//
// The real assertAdminActor() still runs, so role, ban, password-change and
// id-mismatch refusals are the production rules.

import { randomBytes } from "node:crypto";

import type { AdminActor, AdminActorRefusal } from "@/lib/admin/actor";

import { sessionFor } from "./admin-session";

const SESSION_HEADER = "x-test-session";
const sessions = new Map<string, Record<string, unknown>>();
let counter = 0;

/** A fresh 24-hex user id, like an ObjectId. */
export function newUserId(): string {
  return randomBytes(12).toString("hex");
}

/**
 * An actor whose headers resolve to a session user: an active admin with a
 * fresh id unless `fields` say otherwise (`role`, `banned`, ...).
 */
export function testActor(fields: Record<string, unknown> = {}): AdminActor {
  const id = typeof fields.id === "string" ? fields.id : newUserId();
  const token = `session-${++counter}`;
  sessions.set(token, { ...fields, id });
  return { id, headers: new Headers({ [SESSION_HEADER]: token }) };
}

/** Stand-in for getSessionFromDb: the session behind the test header. */
export async function fakeSessionFromDb(headers: Headers) {
  const token = headers.get(SESSION_HEADER);
  const user = token === null ? undefined : sessions.get(token);
  return user === undefined ? null : sessionFor(user);
}

/**
 * Callers every admin service must refuse, with the reason it reports:
 * signed out, a customer, a banned admin, an admin on a temporary password,
 * and a real admin session presented with another user's id.
 */
export function refusedActors(): [string, AdminActor, AdminActorRefusal][] {
  const admin = testActor();
  return [
    [
      "a signed-out caller",
      { id: newUserId(), headers: new Headers() },
      "signed_out",
    ],
    ["a customer", testActor({ role: "customer" }), "not_admin"],
    ["a banned admin", testActor({ banned: true }), "not_admin"],
    [
      "an admin on a temporary password",
      testActor({ mustChangePassword: true }),
      "must_change_password",
    ],
    [
      "an admin session with another id",
      { id: newUserId(), headers: admin.headers },
      "actor_mismatch",
    ],
  ];
}

/**
 * For a test file that already mocks getSessionFromDb (`fallback`): test
 * actors resolve through fakeSessionFromDb, every other request (an action's
 * own headers) still goes to the file's mock.
 */
export function sessionsWithTestActors<T>(
  fallback: (headers: Headers) => T,
): (headers: Headers) => Promise<unknown> {
  return async (headers) =>
    headers.has(SESSION_HEADER)
      ? fakeSessionFromDb(headers)
      : await fallback(headers);
}
