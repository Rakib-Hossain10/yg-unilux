// Tests for src/lib/seed-admin.ts against real Better Auth on an in-memory
// MongoDB: creating the admin, refusing bad input, and a CLI reset that ends
// sessions, revokes device tokens, lifts a ban and clears login counters.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { type Auth, createAuth } from "./auth";
import { handleAuthRequest } from "./auth-handler";
import { getDb } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";
import { buildKey, hashEmail } from "./rate-limit";
import { SeedAdminError, seedAdmin } from "./seed-admin";

const BASE = "http://localhost:3000";
const ADMIN_EMAIL = "seed-admin@example.com";
const PASSWORD = "first-admin-pass-1";
const NEW_PASSWORD = "second-admin-pass-2";

setupMemoryDb("yg_seed_admin_test", { replSet: true });

let auth: Auth;
let ipCounter = 1;

function stubEnv(): void {
  vi.stubEnv("AUTH_SECRET", "seed-auth-secret-for-better-auth-tests-0123456");
  vi.stubEnv("AUTH_URL", BASE);
  vi.stubEnv("IP_HASH_SECRET", "seed-ip-secret-for-better-auth-tests-9876543");
}

beforeAll(async () => {
  stubEnv();
  await LoginAttemptModel.createIndexes();
  await AuditLogModel.createIndexes();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: () => undefined });
  Object.assign(globalThis, { __ygUniluxAuth: auth });
}, 120_000);

beforeEach(() => {
  stubEnv();
});

const users = () => getDb().collection("users");

/*
 * Counters keyed by this email (any email-* namespace). Better Auth's own
 * per-network rows ("ba-limit:") belong to no email and stay, by design.
 */
const emailCounters = (email: string) =>
  LoginAttemptModel.countDocuments({
    key: { $regex: `^email-[a-z-]+:${hashEmail(email)}` },
  });

/* A real sign-in through our route handler; returns the HTTP status. */
async function signInStatus(email: string, password: string): Promise<number> {
  const response = await handleAuthRequest(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-vercel-forwarded-for": `203.0.113.${ipCounter++ % 250}`,
      },
      body: JSON.stringify({ email, password }),
    }),
  );
  return response.status;
}

describe("seedAdmin create", () => {
  it("refuses bad input before touching the database", async () => {
    const cases = [
      { mode: "create", email: "not-an-email", name: "A", password: PASSWORD },
      { mode: "create", email: ADMIN_EMAIL, name: "  ", password: PASSWORD },
      {
        mode: "create",
        email: ADMIN_EMAIL,
        name: "A",
        password: "short-11-ch",
      },
      {
        mode: "create",
        email: ADMIN_EMAIL,
        name: "A",
        password: "x".repeat(129),
      },
    ] as const;
    for (const input of cases) {
      await expect(seedAdmin(auth, input)).rejects.toBeInstanceOf(
        SeedAdminError,
      );
    }
    expect(await users().countDocuments({})).toBe(0);
  });

  it("creates a ready-to-use admin (role admin, no forced password change)", async () => {
    // A leftover lockout counter for this email must not block the new admin.
    await LoginAttemptModel.create({
      key: buildKey("email-login", hashEmail(ADMIN_EMAIL)),
      count: 99,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const result = await seedAdmin(auth, {
      mode: "create",
      email: " Seed-Admin@Example.com ".trim(),
      name: "  YG Admin ",
      password: PASSWORD,
    });
    expect(result).toMatchObject({ mode: "create", email: ADMIN_EMAIL });

    const stored = await users().findOne({ email: ADMIN_EMAIL });
    expect(stored).toMatchObject({
      role: "admin",
      name: "YG Admin",
      mustChangePassword: false,
    });
    expect(await emailCounters(ADMIN_EMAIL)).toBe(0);
    expect(await signInStatus(ADMIN_EMAIL, PASSWORD)).toBe(200);

    const entry = await AuditLogModel.findOne({
      action: "admin.cli_create",
    }).lean();
    expect(entry?.target).toEqual({ type: "user", id: result.userId });
    expect(JSON.stringify(entry)).not.toContain(PASSWORD);
  });

  it("refuses to create a second account with the same email", async () => {
    await expect(
      seedAdmin(auth, {
        mode: "create",
        email: ADMIN_EMAIL,
        name: "Again",
        password: PASSWORD,
      }),
    ).rejects.toThrow(/already exists.*--reset/);
  });
});

describe("seedAdmin reset", () => {
  it("refuses an unknown email and a customer account", async () => {
    await expect(
      seedAdmin(auth, {
        mode: "reset",
        email: "nobody@example.com",
        password: NEW_PASSWORD,
      }),
    ).rejects.toThrow(/No account/);

    await auth.api.createUser({
      body: {
        email: "seed-customer@example.com",
        name: "C",
        password: PASSWORD,
      },
    });
    await expect(
      seedAdmin(auth, {
        mode: "reset",
        email: "seed-customer@example.com",
        password: NEW_PASSWORD,
      }),
    ).rejects.toThrow(/not an admin/);
    // The customer was neither promoted nor given the new password.
    const customer = await users().findOne({
      email: "seed-customer@example.com",
    });
    expect(customer?.role).toBe("customer");
    expect(await signInStatus("seed-customer@example.com", NEW_PASSWORD)).toBe(
      401,
    );
  });

  it("sets the new password, ends sessions, bumps the device epoch, unbans and clears counters", async () => {
    expect(await signInStatus(ADMIN_EMAIL, PASSWORD)).toBe(200);
    const before = await users().findOne({ email: ADMIN_EMAIL });
    const userId = String(before?._id);
    expect(
      await getDb()
        .collection("sessions")
        .countDocuments({ userId: before?._id }),
    ).toBeGreaterThan(0);

    await users().updateOne(
      { email: ADMIN_EMAIL },
      {
        $set: {
          banned: true,
          banReason: "test",
          banExpires: null,
          mustChangePassword: true,
        },
      },
    );
    await LoginAttemptModel.create({
      key: buildKey("email-reset", hashEmail(ADMIN_EMAIL)),
      count: 5,
      expiresAt: new Date(Date.now() + 600_000),
    });

    const result = await seedAdmin(auth, {
      mode: "reset",
      email: ADMIN_EMAIL,
      password: NEW_PASSWORD,
    });
    expect(result).toEqual({
      mode: "reset",
      userId,
      email: ADMIN_EMAIL,
      unbanned: true,
    });

    const after = await users().findOne({ email: ADMIN_EMAIL });
    expect(after).toMatchObject({
      banned: false,
      banReason: null,
      banExpires: null,
      mustChangePassword: false,
      role: "admin",
    });
    expect(after?.deviceEpoch).toBe((before?.deviceEpoch ?? 0) + 1);
    // Phase 5: the CLI-chosen password counts as set by the admin.
    expect(after?.passwordSetAt).toBeInstanceOf(Date);
    expect(
      await getDb()
        .collection("sessions")
        .countDocuments({ userId: before?._id }),
    ).toBe(0);
    expect(await emailCounters(ADMIN_EMAIL)).toBe(0);

    expect(await signInStatus(ADMIN_EMAIL, PASSWORD)).toBe(401);
    expect(await signInStatus(ADMIN_EMAIL, NEW_PASSWORD)).toBe(200);
    expect(
      await AuditLogModel.countDocuments({
        action: "admin.cli_reset_password",
      }),
    ).toBe(1);
  });

  it("adds a missing credential account (e.g. after an interrupted create)", async () => {
    const admin = await users().findOne({ email: ADMIN_EMAIL });
    await getDb().collection("accounts").deleteMany({ userId: admin?._id });
    await seedAdmin(auth, {
      mode: "reset",
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    expect(await signInStatus(ADMIN_EMAIL, PASSWORD)).toBe(200);
  });
});
