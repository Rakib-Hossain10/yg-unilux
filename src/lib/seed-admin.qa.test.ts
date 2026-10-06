// QA tests for src/lib/seed-admin.ts (Phase 1 task 7): a reset really kills a
// live session and old device tokens, the stored epoch is read (not assumed 0),
// mixed-case emails, ordering when a later step fails, and no password leaks.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditLogModel } from "@/models/audit-log";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { type Auth, createAuth } from "./auth";
import { handleAuthRequest } from "./auth-handler";
import { getDb } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";
import { issueDeviceToken, verifyDeviceToken } from "./device-token";
import { SeedAdminError, seedAdmin } from "./seed-admin";

const BASE = "http://localhost:3000";
const EMAIL = "qa-seed-admin@example.com";
const PASSWORD = "qa-first-admin-pass-1";
const NEW_PASSWORD = "qa-second-admin-pass-2";

setupMemoryDb("yg_seed_admin_qa", { replSet: true });

let auth: Auth;
let ip = 1;

function stubEnv(): void {
  vi.stubEnv("AUTH_SECRET", "qa-seed-auth-secret-for-better-auth-0123456789");
  vi.stubEnv("AUTH_URL", BASE);
  vi.stubEnv("IP_HASH_SECRET", "qa-seed-ip-secret-for-better-auth-9876543210");
}

beforeAll(async () => {
  stubEnv();
  await LoginAttemptModel.createIndexes();
  await AuditLogModel.createIndexes();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: () => undefined });
  Object.assign(globalThis, { __ygUniluxAuth: auth });
}, 120_000);

beforeEach(() => stubEnv());

const users = () => getDb().collection("users");

/* Signs in through the real route handler; returns status and session cookie. */
async function signIn(
  email: string,
  password: string,
): Promise<{ status: number; cookie: string }> {
  const response = await handleAuthRequest(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        "x-vercel-forwarded-for": `198.51.100.${ip++ % 250}`,
      },
      body: JSON.stringify({ email, password }),
    }),
  );
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => c?.includes("session_token"))
    .join("; ");
  return { status: response.status, cookie };
}

async function sessionFor(cookie: string) {
  return auth.api.getSession({ headers: new Headers({ cookie }) });
}

describe("seedAdmin QA", () => {
  it("creates the admin from a mixed-case email and refuses a case variant", async () => {
    await seedAdmin(auth, {
      mode: "create",
      email: "QA-Seed-Admin@Example.COM",
      name: "QA Admin",
      password: PASSWORD,
    });
    expect(await users().countDocuments({ email: EMAIL })).toBe(1);
    await expect(
      seedAdmin(auth, {
        mode: "create",
        email: EMAIL.toUpperCase(),
        name: "Twice",
        password: PASSWORD,
      }),
    ).rejects.toThrow(/already exists/);
    expect(await users().countDocuments({})).toBe(1);
  });

  it("stores only an argon2id hash; the plaintext is nowhere in the database", async () => {
    const admin = await users().findOne({ email: EMAIL });
    const account = await getDb()
      .collection("accounts")
      .findOne({ userId: admin?._id, providerId: "credential" });
    expect(String(account?.password)).toMatch(/^\$argon2id\$/);
    for (const name of [
      "users",
      "accounts",
      "sessions",
      "auditlogs",
      "auditLog",
      "verifications",
    ]) {
      const docs = await getDb().collection(name).find({}).toArray();
      expect(JSON.stringify(docs)).not.toContain(PASSWORD);
    }
  });

  it("a reset with a mixed-case email ends a live session and rejects old device tokens", async () => {
    const live = await signIn(EMAIL, PASSWORD);
    expect(live.status).toBe(200);
    expect(await sessionFor(live.cookie)).not.toBeNull();

    // A non-zero stored epoch proves the reset reads it (0 + 1 would hide a bug).
    await users().updateOne({ email: EMAIL }, { $set: { deviceEpoch: 7 } });
    const oldToken = issueDeviceToken(EMAIL, 7).value;
    expect(verifyDeviceToken(oldToken, EMAIL, 7)).not.toBeNull();

    await seedAdmin(auth, {
      mode: "reset",
      email: "Qa-Seed-ADMIN@example.com",
      password: NEW_PASSWORD,
    });

    const after = await users().findOne({ email: EMAIL });
    expect(after?.deviceEpoch).toBe(8);
    expect(verifyDeviceToken(oldToken, EMAIL, after?.deviceEpoch)).toBeNull();
    expect(await sessionFor(live.cookie)).toBeNull();
    expect((await signIn(EMAIL, PASSWORD)).status).toBe(401);
    expect((await signIn(EMAIL, NEW_PASSWORD)).status).toBe(200);
  });

  it("resets an account whose role list holds admin among others", async () => {
    await users().updateOne(
      { email: EMAIL },
      { $set: { role: "customer,admin" } },
    );
    await expect(
      seedAdmin(auth, { mode: "reset", email: EMAIL, password: PASSWORD }),
    ).resolves.toMatchObject({ mode: "reset" });
    const after = await users().findOne({ email: EMAIL });
    expect(after?.role).toBe("customer,admin");
    await users().updateOne({ email: EMAIL }, { $set: { role: "admin" } });
  });

  it("if a later step fails, the password is already changed and the old sessions are already gone", async () => {
    const live = await signIn(EMAIL, PASSWORD);
    expect(live.status).toBe(200);

    const context = await auth.$context;
    const spy = vi
      .spyOn(context.internalAdapter, "updateUser")
      .mockRejectedValueOnce(new Error("simulated failure"));
    await expect(
      seedAdmin(auth, { mode: "reset", email: EMAIL, password: NEW_PASSWORD }),
    ).rejects.toThrow("simulated failure");
    spy.mockRestore();

    expect(await sessionFor(live.cookie)).toBeNull();
    expect((await signIn(EMAIL, PASSWORD)).status).toBe(401);
    // A rerun completes the clean-up.
    await seedAdmin(auth, { mode: "reset", email: EMAIL, password: PASSWORD });
    expect((await signIn(EMAIL, PASSWORD)).status).toBe(200);
  });

  it("lifts a timed ban too (banExpires in the future)", async () => {
    await users().updateOne(
      { email: EMAIL },
      {
        $set: {
          banned: true,
          banReason: "x",
          banExpires: new Date(Date.now() + 86_400_000),
        },
      },
    );
    expect((await signIn(EMAIL, PASSWORD)).status).toBe(403);
    const result = await seedAdmin(auth, {
      mode: "reset",
      email: EMAIL,
      password: PASSWORD,
    });
    expect(result.unbanned).toBe(true);
    expect((await signIn(EMAIL, PASSWORD)).status).toBe(200);
  });

  it("refusal messages never quote the password or the email", async () => {
    const secret = "S3cret-but-way-too-long-".repeat(10);
    const cases = [
      { mode: "reset", email: "victim@example.com", password: "short-pw" },
      { mode: "reset", email: "victim@example.com", password: secret },
      { mode: "reset", email: "not-an-email-S3cret", password: PASSWORD },
      { mode: "reset", email: "nobody-x@example.com", password: PASSWORD },
    ] as const;
    for (const input of cases) {
      const error = await seedAdmin(auth, input).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SeedAdminError);
      const message = (error as Error).message;
      expect(message).not.toContain(input.password);
      expect(message).not.toContain(input.email);
      expect(message).not.toMatch(/S3cret/);
    }
  });

  it("audit entries name the admin as actor and hold no password or email", async () => {
    const admin = await users().findOne({ email: EMAIL });
    const entries = await AuditLogModel.find({
      action: { $in: ["admin.cli_create", "admin.cli_reset_password"] },
    }).lean();
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const entry of entries) {
      expect(String(entry.actor)).toBe(String(admin?._id));
      const text = JSON.stringify(entry);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(NEW_PASSWORD);
      expect(text).not.toContain(EMAIL);
    }
  });
});
