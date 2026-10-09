// Test helper: real Better Auth on the in-memory replica set, installed as
// the app's instance (so getAuth()/withAuth()/getAuthContext() use it), plus
// a signed-in admin whose request headers the admin services take.

import { beforeAll, beforeEach, vi } from "vitest";

import { type Auth, createAuth } from "@/lib/auth";
import { handleAuthRequest } from "@/lib/auth-handler";
import { getDb, mongoose } from "@/lib/db";
import { syncBetterAuthIndexes } from "@/lib/db-indexes";
import { AccessRequestModel } from "@/models/access-request";
import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";

import { setupMemoryDb } from "./memory-db";

export const AUTH_BASE = "http://localhost:3000";

/** Test-only secrets (not real ones). */
function stubAuthEnv(): void {
  vi.stubEnv("AUTH_SECRET", "auth-harness-test-secret-0123456789abcdef");
  vi.stubEnv("AUTH_URL", AUTH_BASE);
  vi.stubEnv("IP_HASH_SECRET", "auth-harness-ip-secret-0123456789abcdefgh");
}

export interface AuthHarness {
  auth: Auth;
  /** Work Better Auth handed to `after()` (e.g. reset emails). */
  background: Promise<unknown>[];
}

let ipCounter = 1;
/** A fresh documentation-range IP per request, so limits never interfere. */
export const freshIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

/**
 * Registers the memory DB and Better Auth for the calling test file. The
 * returned object is filled in by beforeAll.
 */
export function setupAuthHarness(dbName: string): AuthHarness {
  setupMemoryDb(dbName, { replSet: true });
  const harness = { background: [] } as unknown as AuthHarness;

  beforeAll(async () => {
    stubAuthEnv();
    await Promise.all([
      LoginAttemptModel.createIndexes(),
      AuditLogModel.createIndexes(),
      AccessRequestModel.createIndexes(),
    ]);
    await syncBetterAuthIndexes(getDb());
    harness.auth = createAuth({
      runInBackground: (task) => void harness.background.push(task),
    });
    Object.assign(globalThis, { __ygUniluxAuth: harness.auth });
  }, 120_000);

  beforeEach(() => {
    stubAuthEnv();
  });

  return harness;
}

/** POSTs to the real /api/auth handler from a fresh network. */
export function authCall(path: string, body: unknown, cookie?: string) {
  const headers = new Headers({
    "content-type": "application/json",
    origin: AUTH_BASE,
    "x-vercel-forwarded-for": freshIp(),
  });
  if (cookie) headers.set("cookie", cookie);
  return handleAuthRequest(
    new Request(`${AUTH_BASE}/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** The `yg.*` cookies of a response, as one Cookie header. */
export function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .filter((pair) => pair.startsWith("yg."))
    .join("; ");
}

/** Signs in and returns the Cookie header (throws on failure). */
export async function signIn(email: string, password: string): Promise<string> {
  const response = await authCall("/sign-in/email", {
    email,
    password,
    rememberMe: true,
  });
  if (response.status !== 200) {
    throw new Error(`sign-in failed with ${response.status}`);
  }
  return cookieHeader(response);
}

/** A signed-in admin as the admin services take it. */
export async function signedInAdmin(
  harness: AuthHarness,
  email = "harness-admin@example.com",
): Promise<{ id: string; headers: Headers }> {
  const password = "harness-admin-password-1";
  const { user } = await harness.auth.api.createUser({
    body: {
      email,
      password,
      name: "Harness Admin",
      role: "admin",
      data: { mustChangePassword: false },
    },
  });
  const cookie = await signIn(email, password);
  return {
    id: user.id,
    headers: new Headers({ cookie, origin: AUTH_BASE }),
  };
}

/** The raw users document (tests may read Better Auth's collection). */
export function rawUser(id: string) {
  return getDb()
    .collection<Record<string, unknown>>("users")
    .findOne({ _id: new mongoose.Types.ObjectId(id) });
}

/** How many sessions the user has. */
export function sessionCount(id: string): Promise<number> {
  return getDb()
    .collection("sessions")
    .countDocuments({ userId: new mongoose.Types.ObjectId(id) });
}

/** How many reset/invite rows the user has (value = user id). */
export function linkCount(id: string): Promise<number> {
  return getDb().collection("verifications").countDocuments({ value: id });
}

/** Sets raw fields on a user, for seeding states in tests only. */
export async function seedUserFields(
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await getDb()
    .collection("users")
    .updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });
}
