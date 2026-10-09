// Tests for src/lib/account-writes.ts against real Better Auth on the memory
// DB: every writer's fields are read back from the RAW users document (the
// adapter silently drops undeclared keys), the allowlist refuses anything
// else, and revokePasswordLinks deletes only the right verification rows.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  AccountWriteError,
  type AccountFields,
  accountFieldsSchema,
  epochOf,
  bumpDeviceEpoch,
  recordPasswordSet,
  recoverAdminFromCli,
  revokePasswordLinks,
  updateAccountFields,
} from "./account-writes";
import { type Auth, createAuth } from "./auth";
import { getDb, mongoose } from "./db";
import { syncBetterAuthIndexes } from "./db-indexes";

setupMemoryDb("yg_account_writes_test", { replSet: true });

let auth: Auth;
let context: Awaited<Auth["$context"]>;
let userId: string;
let otherId: string;

function stubEnv(): void {
  vi.stubEnv("AUTH_SECRET", "account-writes-test-secret-0123456789abcdef");
  vi.stubEnv("AUTH_URL", "http://localhost:3000");
  vi.stubEnv("IP_HASH_SECRET", "account-writes-ip-secret-0123456789abcdef");
}

const users = () => getDb().collection("users");
const raw = (id: string) =>
  users().findOne({ _id: new mongoose.Types.ObjectId(id) });

beforeAll(async () => {
  stubEnv();
  await syncBetterAuthIndexes(getDb());
  auth = createAuth({ runInBackground: () => undefined });
  context = await auth.$context;
  userId = (
    await auth.api.createUser({
      body: {
        email: "aw-user@example.com",
        password: "aw-user-password-1",
        name: "AW User",
      },
    })
  ).user.id;
  otherId = (
    await auth.api.createUser({
      body: {
        email: "aw-other@example.com",
        password: "aw-other-password-1",
        name: "AW Other",
      },
    })
  ).user.id;
}, 120_000);

beforeEach(() => stubEnv());

describe("updateAccountFields: every allowlisted field is really stored", () => {
  const at = new Date("2026-10-09T10:00:00.000Z");
  const cases: Array<[keyof AccountFields, AccountFields]> = [
    ["mustChangePassword", { mustChangePassword: false }],
    ["accessExpiresAt", { accessExpiresAt: at }],
    ["company", { company: "Acme Lighting" }],
    ["country", { country: "Hong Kong" }],
    ["expiryReminderFor", { expiryReminderFor: at }],
    ["invitedAt", { invitedAt: at }],
    ["inviteExpiresAt", { inviteExpiresAt: at }],
    ["passwordSetAt", { passwordSetAt: at }],
  ];

  it.each(cases)("%s", async (field, patch) => {
    await updateAccountFields(context, userId, patch);
    const doc = await raw(userId);
    expect(doc?.[field]).toEqual(patch[field]);
  });

  it("stores null (clears) a date", async () => {
    await updateAccountFields(context, userId, { accessExpiresAt: at });
    await updateAccountFields(context, userId, { accessExpiresAt: null });
    expect((await raw(userId))?.accessExpiresAt).toBeNull();
  });

  it("covers every key of the real schema (no field forgotten above)", () => {
    expect(cases.map(([field]) => field).sort()).toEqual(
      Object.keys(accountFieldsSchema.shape).sort(),
    );
  });

  it("trims profile text", async () => {
    await updateAccountFields(context, userId, { company: "  Acme  " });
    expect((await raw(userId))?.company).toBe("Acme");
  });
});

describe("updateAccountFields: refusals", () => {
  async function refused(patch: unknown, id = userId) {
    const before = await raw(userId);
    const error = await updateAccountFields(
      context,
      id,
      patch as AccountFields,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountWriteError);
    expect(await raw(userId)).toEqual(before);
    return error as AccountWriteError;
  }

  it.each([
    ["deviceEpoch (only moves through its own writers)", { deviceEpoch: 0 }],
    ["role", { role: "admin" }],
    ["banned", { banned: false }],
    ["email", { email: "x@example.com" }],
    ["an Invalid Date", { accessExpiresAt: new Date("nope") }],
    ["a date string", { accessExpiresAt: "2027-01-01" }],
    ["a newline in company", { company: "Acme\nBcc: x" }],
    ["a control character in country", { country: "HK\u0007" }],
    ["an overlong company", { company: "a".repeat(201) }],
    ["an empty patch", {}],
    ["a patch of undefined values", { company: undefined }],
  ])("%s", async (_label, patch) => {
    expect((await refused(patch)).reason).toBe("invalid_input");
  });

  it.each(["", "not-an-id", "ABCDEF0123456789ABCDEF01", "0".repeat(25)])(
    "a malformed user id %j",
    async (id) => {
      expect((await refused({ company: "x" }, id)).reason).toBe(
        "invalid_input",
      );
    },
  );

  it("an unknown user", async () => {
    const id = new mongoose.Types.ObjectId().toHexString();
    expect((await refused({ company: "x" }, id)).reason).toBe("user_not_found");
  });

  it("the error message names no value", async () => {
    const error = await refused({ company: "secret\nvalue" });
    expect(error.message).not.toContain("secret");
  });
});

describe("epoch and password writers", () => {
  it("bumpDeviceEpoch moves the epoch up by one", async () => {
    const before = Number((await raw(userId))?.deviceEpoch ?? 0);
    expect(await bumpDeviceEpoch(context, userId)).toBe(before + 1);
    expect((await raw(userId))?.deviceEpoch).toBe(before + 1);
  });

  it("recordPasswordSet clears the flag, stamps passwordSetAt and bumps the epoch in one write", async () => {
    await updateAccountFields(context, userId, { mustChangePassword: true });
    const before = Number((await raw(userId))?.deviceEpoch ?? 0);
    const now = new Date("2026-10-09T12:34:56.000Z");
    expect(await recordPasswordSet(context, userId, now)).toBe(before + 1);
    expect(await raw(userId)).toMatchObject({
      mustChangePassword: false,
      passwordSetAt: now,
      deviceEpoch: before + 1,
    });
  });

  it("returns null for an unknown user and refuses a bad id", async () => {
    const unknown = new mongoose.Types.ObjectId().toHexString();
    expect(await bumpDeviceEpoch(context, unknown)).toBeNull();
    expect(await recordPasswordSet(context, unknown)).toBeNull();
    await expect(bumpDeviceEpoch(context, "")).rejects.toBeInstanceOf(
      AccountWriteError,
    );
    await expect(recordPasswordSet(context, "x")).rejects.toBeInstanceOf(
      AccountWriteError,
    );
  });

  it("recoverAdminFromCli clears the flag, lifts a ban and bumps the epoch", async () => {
    await users().updateOne(
      { _id: new mongoose.Types.ObjectId(otherId) },
      {
        $set: {
          mustChangePassword: true,
          banned: true,
          banReason: "x",
          banExpires: new Date("2030-01-01"),
          deviceEpoch: 4,
        },
      },
    );
    await recoverAdminFromCli(context, otherId);
    const doc = await raw(otherId);
    expect(doc).toMatchObject({
      mustChangePassword: false,
      banned: false,
      banReason: null,
      banExpires: null,
      deviceEpoch: 5,
    });
    expect(doc?.passwordSetAt).toBeInstanceOf(Date);
    await expect(
      recoverAdminFromCli(context, new mongoose.Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ reason: "user_not_found" });
    await expect(recoverAdminFromCli(context, "x")).rejects.toMatchObject({
      reason: "invalid_input",
    });
  });
});

describe("revokePasswordLinks", () => {
  const verifications = () => getDb().collection("verifications");

  async function link(value: string, createdAt: Date) {
    const row = await context.internalAdapter.createVerificationValue({
      value,
      identifier: `reset-password:${new mongoose.Types.ObjectId().toHexString()}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await verifications().updateOne(
      { _id: new mongoose.Types.ObjectId(row.id) },
      { $set: { createdAt } },
    );
    return row.id;
  }

  const ids = async () =>
    (await verifications().find({}).toArray()).map((d) => String(d._id));

  beforeEach(async () => {
    await verifications().deleteMany({});
  });

  it("deletes every row of the user and none of another user's", async () => {
    const a = await link(userId, new Date("2026-10-01"));
    const b = await link(userId, new Date("2026-10-02"));
    const other = await link(otherId, new Date("2026-10-01"));
    await revokePasswordLinks(context, userId);
    const left = await ids();
    expect(left).toEqual([other]);
    expect(left).not.toContain(a);
    expect(left).not.toContain(b);
  });

  it("with except keeps exactly that row, even with the same createdAt", async () => {
    const at = new Date("2026-10-02T00:00:00Z");
    const a = await link(userId, at);
    const b = await link(userId, at);
    const other = await link(otherId, at);
    await revokePasswordLinks(context, userId, { except: b });
    const left = await ids();
    expect(left).not.toContain(a);
    expect(left.sort()).toEqual([b, other].sort());
  });

  it("refuses an empty or malformed id instead of matching value ''", async () => {
    const kept = await link("", new Date());
    await expect(revokePasswordLinks(context, "")).rejects.toBeInstanceOf(
      AccountWriteError,
    );
    expect(await ids()).toEqual([kept]);
  });
});

describe("epochOf", () => {
  it("reads a safe non-negative integer and treats anything else as 0", () => {
    expect(epochOf({ deviceEpoch: 3 })).toBe(3);
    for (const bad of [undefined, null, -1, 1.5, "2", Number.MAX_VALUE]) {
      expect(epochOf({ deviceEpoch: bad })).toBe(0);
    }
    expect(epochOf(null)).toBe(0);
  });

  it("a malformed stored epoch restarts at 1", async () => {
    await users().updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { deviceEpoch: "corrupt" } },
    );
    expect(await bumpDeviceEpoch(context, userId)).toBe(1);
    expect((await raw(userId))?.deviceEpoch).toBe(1);
  });
});
