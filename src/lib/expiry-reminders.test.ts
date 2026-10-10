// Tests for the access-expiry reminder job (src/lib/expiry-reminders.ts,
// ADR 0072) with REAL Better Auth on the memory replica set: who is due
// (window, null expiry, expired, banned, admin), idempotency, re-arming on
// an extension, catching up a missed day, per-user failures, the digest to
// the settings address, the counts-only audit entry, the dry run, the run
// lock and the time budget.

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { endOfUtcDay } from "@/lib/access-expiry";
import { getDb } from "@/lib/db";
import { acquireLock, buildKey, releaseLock } from "@/lib/rate-limit";
import { SETTINGS_KEYS } from "@/lib/schemas/settings";
import { AuditLogModel, SiteContentModel, UserModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import {
  rawUser,
  seedUserFields,
  setupAuthHarness,
} from "../../test/helpers/auth-harness";

import {
  runExpiryReminders,
  type ExpiryReminderOptions,
} from "./expiry-reminders";

const mail = vi.hoisted(() => ({
  reminders: [] as {
    to: string;
    name: string;
    accessExpiresAt: Date;
    idempotencyKey?: string;
  }[],
  digests: [] as {
    to: string;
    idempotencyKey?: string;
    customers: readonly {
      name: string;
      company?: string | null;
      accessExpiresAt: Date;
    }[];
  }[],
  failFor: new Set<string>(),
  failDigest: 0,
}));

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendExpiryReminderEmail: vi.fn(
      async (input: (typeof mail.reminders)[number]) => {
        if (mail.failFor.has(input.to)) {
          throw new actual.EmailSendError("provider_error", {
            statusCode: 429,
            providerCode: "rate_limit_exceeded",
          });
        }
        mail.reminders.push(input);
        return { id: "email-id" };
      },
    ),
    sendExpiryDigestEmail: vi.fn(
      async (input: (typeof mail.digests)[number]) => {
        if (mail.failDigest > 0) {
          mail.failDigest -= 1;
          throw new actual.EmailSendError("unexpected");
        }
        mail.digests.push(input);
        return { id: "digest-id" };
      },
    ),
  };
});

const writes = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/account-writes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/account-writes")>();
  return {
    ...actual,
    updateAccountFields: vi.fn(
      async (...args: Parameters<typeof actual.updateAccountFields>) => {
        if (writes.fail) throw new Error("db write failed");
        return actual.updateAccountFields(...args);
      },
    ),
  };
});

const harness = setupAuthHarness("yg_expiry_reminders_test");

const NOW = new Date("2026-10-10T08:00:00.000Z");
const DAY = 86_400_000;
/** Access that ends at the end of the UTC day `days` from NOW. */
const endsIn = (days: number) =>
  endOfUtcDay(new Date(NOW.getTime() + days * DAY));

const SETTINGS_EMAIL = "sales@yg.example";
const ENV_EMAIL = "office@yg.example";

let counter = 0;

async function makeUser(
  fields: Record<string, unknown>,
  role = "customer",
): Promise<{ id: string; email: string; name: string }> {
  const n = ++counter;
  const email = `reminder-${n}@expiry.test`;
  const name = `Customer Number${n}`;
  const { user } = await harness.auth.api.createUser({
    body: {
      email,
      password: `reminder-password-${n}-xyz`,
      name,
      role: role as "customer",
      data: { mustChangePassword: false },
    },
  });
  await seedUserFields(user.id, { company: `Company ${n}`, ...fields });
  return { id: user.id, email, name };
}

const run = (options: ExpiryReminderOptions = {}) =>
  runExpiryReminders({ now: NOW, pauseMs: 0, ...options });

const remindedEmails = () => mail.reminders.map((m) => m.to).sort();

beforeEach(async () => {
  mail.reminders.length = 0;
  mail.digests.length = 0;
  mail.failFor.clear();
  mail.failDigest = 0;
  writes.fail = false;
  vi.stubEnv("COMPANY_EMAIL", ENV_EMAIL);
  await Promise.all([
    getDb().collection("users").deleteMany({}),
    getDb().collection("sessions").deleteMany({}),
    getDb().collection("accounts").deleteMany({}),
    AuditLogModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
    SiteContentModel.collection.deleteMany({}),
  ]);
  await SiteContentModel.collection.insertOne({
    key: SETTINGS_KEYS.companyEmail,
    value: SETTINGS_EMAIL,
  });
});

describe("who is due", () => {
  it("reminds customers whose access ends within 7 days, once, and marks them", async () => {
    const soon = await makeUser({ accessExpiresAt: endsIn(3) });
    const edge = await makeUser({ accessExpiresAt: endsIn(6) });

    const summary = await run();

    expect(summary).toMatchObject({
      status: "completed",
      dryRun: false,
      due: 2,
      sent: 2,
      failed: 0,
      markFailed: 0,
      truncated: false,
      digest: "sent",
    });
    expect(remindedEmails()).toEqual([soon.email, edge.email].sort());
    expect((await rawUser(soon.id))?.expiryReminderFor).toEqual(endsIn(3));
    expect((await rawUser(edge.id))?.expiryReminderFor).toEqual(endsIn(6));
    const reminder = mail.reminders.find((m) => m.to === soon.email);
    expect(reminder).toMatchObject({
      name: soon.name,
      accessExpiresAt: endsIn(3),
      idempotencyKey: `expiry-reminder/${soon.id}/${endsIn(3).getTime()}`,
    });
  });

  it("the window is now < expiry <= now + 7 days (boundaries)", async () => {
    const atLimit = await makeUser({
      accessExpiresAt: new Date(NOW.getTime() + 7 * DAY),
    });
    await makeUser({ accessExpiresAt: new Date(NOW.getTime() + 7 * DAY + 1) });
    await makeUser({ accessExpiresAt: NOW }); // ends exactly now = expired
    const justAfter = await makeUser({
      accessExpiresAt: new Date(NOW.getTime() + 1),
    });

    await run();
    expect(remindedEmails()).toEqual([atLimit.email, justAfter.email].sort());
  });

  it("skips null expiry, expired, too far out, banned and the admin", async () => {
    const due = await makeUser({ accessExpiresAt: endsIn(2) });
    await makeUser({ accessExpiresAt: null });
    await makeUser({}); // field missing
    await makeUser({ accessExpiresAt: endsIn(-1) });
    await makeUser({ accessExpiresAt: endsIn(10) });
    await makeUser({ accessExpiresAt: endsIn(2), banned: true });
    await makeUser({
      accessExpiresAt: endsIn(2),
      banned: true,
      banExpires: new Date(NOW.getTime() + DAY),
    });
    await makeUser({ accessExpiresAt: endsIn(2) }, "admin");
    await makeUser({ accessExpiresAt: endsIn(2), role: "admin,customer" });
    await makeUser({ accessExpiresAt: endsIn(2), role: "editor" });

    const summary = await run();
    expect(summary.due).toBe(1);
    expect(remindedEmails()).toEqual([due.email]);
  });

  it("a ban that has ended no longer blocks the reminder", async () => {
    const user = await makeUser({
      accessExpiresAt: endsIn(2),
      banned: true,
      banExpires: new Date(NOW.getTime() - DAY),
    });
    await run();
    expect(remindedEmails()).toEqual([user.email]);
  });
});

describe("idempotency", () => {
  it("a second run sends nothing", async () => {
    await makeUser({ accessExpiresAt: endsIn(4) });
    await makeUser({ accessExpiresAt: endsIn(5) });
    expect((await run()).sent).toBe(2);

    mail.reminders.length = 0;
    mail.digests.length = 0;
    const again = await run({ now: new Date(NOW.getTime() + DAY) });
    expect(again).toMatchObject({ due: 0, sent: 0, digest: "skipped" });
    expect(mail.reminders).toEqual([]);
    expect(mail.digests).toEqual([]);
  });

  it("an extension re-arms the reminder for the new date", async () => {
    const user = await makeUser({ accessExpiresAt: endsIn(3) });
    await run();
    expect(mail.reminders).toHaveLength(1);

    // The admin extends by 30 days; 28 days later the new date is close.
    const extended = endsIn(33);
    await seedUserFields(user.id, { accessExpiresAt: extended });
    mail.reminders.length = 0;
    expect((await run({ now: new Date(NOW.getTime() + 2 * DAY) })).sent).toBe(
      0,
    );
    const later = new Date(NOW.getTime() + 28 * DAY);
    expect((await run({ now: later })).sent).toBe(1);
    expect(mail.reminders[0]?.accessExpiresAt).toEqual(extended);
    expect((await rawUser(user.id))?.expiryReminderFor).toEqual(extended);
  });

  it("a missed day is caught up later in the window", async () => {
    // 7 days out at NOW, but no run happened that day (nor the next four).
    // Five days later, 2 days before the end, the reminder still goes out:
    // the window is "ends within 7 days", not a one-day slice.
    const user = await makeUser({
      accessExpiresAt: new Date(NOW.getTime() + 7 * DAY),
    });
    const summary = await run({ now: new Date(NOW.getTime() + 5 * DAY) });
    expect(summary.sent).toBe(1);
    expect(remindedEmails()).toEqual([user.email]);
  });

  it("processes every batch", async () => {
    for (let i = 0; i < 5; i += 1) {
      await makeUser({ accessExpiresAt: endsIn(1 + (i % 6)) });
    }
    const summary = await run({ batchSize: 2 });
    expect(summary).toMatchObject({ due: 5, sent: 5 });
    expect(new Set(remindedEmails()).size).toBe(5);
  });
});

describe("failures", () => {
  it("a failed send doesn't stop the others and isn't marked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = await makeUser({ accessExpiresAt: endsIn(1) });
    const good = await makeUser({ accessExpiresAt: endsIn(2) });
    mail.failFor.add(bad.email);

    const summary = await run();
    expect(summary).toMatchObject({ due: 2, sent: 1, failed: 1 });
    expect(remindedEmails()).toEqual([good.email]);
    expect((await rawUser(bad.id))?.expiryReminderFor ?? null).toBeNull();
    expect(mail.digests[0]?.customers.map((c) => c.name)).toEqual([good.name]);

    // Logged by type and provider code only.
    const logged = error.mock.calls.flat().join("\n");
    expect(logged).toContain(
      "EmailSendError provider_error 429 rate_limit_exceeded",
    );
    expect(logged).not.toContain("@");
    expect(logged).not.toContain(bad.name);

    // Retried on the next run.
    mail.failFor.clear();
    mail.reminders.length = 0;
    expect((await run()).sent).toBe(1);
    expect(remindedEmails()).toEqual([bad.email]);
  });

  it("a database failure mid-run still sends the digest and audits the run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await makeUser({ accessExpiresAt: endsIn(1) });
    await makeUser({ accessExpiresAt: endsIn(2) });
    const realFind = UserModel.find.bind(UserModel);
    let calls = 0;
    vi.spyOn(UserModel, "find").mockImplementation(((
      ...args: Parameters<typeof UserModel.find>
    ) => {
      calls += 1;
      if (calls > 1) throw new Error("MongoServerSelectionError");
      return realFind(...args);
    }) as typeof UserModel.find);

    const summary = await run({ batchSize: 1 });
    expect(summary).toMatchObject({ status: "aborted", due: 2, sent: 1 });
    expect(remindedEmails()).toEqual([first.email]);
    expect(mail.digests[0]?.customers.map((c) => c.name)).toEqual([first.name]);
    const entry = await AuditLogModel.findOne({}).lean();
    expect(entry?.meta).toMatchObject({
      sent: 1,
      aborted: true,
      digest: "sent",
    });
  });

  it("a sent reminder whose mark fails is counted and stays due", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await makeUser({ accessExpiresAt: endsIn(2) });
    writes.fail = true;
    const summary = await run();
    expect(summary).toMatchObject({ sent: 1, markFailed: 1 });
    const firstKey = mail.reminders[0]?.idempotencyKey;
    expect((await rawUser(user.id))?.expiryReminderFor ?? null).toBeNull();
    // The next run uses the same Resend idempotency key, so no duplicate.
    writes.fail = false;
    mail.reminders.length = 0;
    await run();
    expect(mail.reminders[0]?.idempotencyKey).toBe(firstKey);
    expect(firstKey).toBe(`expiry-reminder/${user.id}/${endsIn(2).getTime()}`);
  });
});

describe("admin digest", () => {
  it("goes to the settings address (it wins over COMPANY_EMAIL) with the reminded customers", async () => {
    const a = await makeUser({ accessExpiresAt: endsIn(2), company: "Acme" });
    const b = await makeUser({ accessExpiresAt: endsIn(5), company: null });
    await run();
    expect(mail.digests).toHaveLength(1);
    expect(mail.digests[0]?.to).toBe(SETTINGS_EMAIL);
    expect(mail.digests[0]?.customers).toEqual([
      { name: a.name, company: "Acme", accessExpiresAt: endsIn(2) },
      { name: b.name, company: null, accessExpiresAt: endsIn(5) },
    ]);
  });

  it("carries an idempotency key per UTC day and set of customers", async () => {
    const a = await makeUser({ accessExpiresAt: endsIn(2) });
    await run();
    const first = mail.digests[0]?.idempotencyKey;
    expect(first).toMatch(/^expiry-digest\/2026-10-10\/[0-9a-f]{32}$/);

    // Same day, same set (a re-armed reminder) → same key; Resend dedupes.
    await seedUserFields(a.id, { expiryReminderFor: null });
    await run({ now: new Date(NOW.getTime() + 60_000) });
    expect(mail.digests[1]?.idempotencyKey).toBe(first);

    // Another customer → another key.
    await makeUser({ accessExpiresAt: endsIn(3) });
    await run();
    expect(mail.digests[2]?.idempotencyKey).toMatch(
      /^expiry-digest\/2026-10-10\//,
    );
    expect(mail.digests[2]?.idempotencyKey).not.toBe(first);

    // Same set on another day → another key.
    await seedUserFields(a.id, { expiryReminderFor: null });
    await run({ now: new Date(NOW.getTime() + DAY) });
    expect(mail.digests[3]?.idempotencyKey).toMatch(
      /^expiry-digest\/2026-10-11\//,
    );
  });

  it("is retried once after a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await makeUser({ accessExpiresAt: endsIn(2) });
    mail.failDigest = 1;
    expect((await run()).digest).toBe("sent");
    expect(mail.digests).toHaveLength(1);
  });

  it("falls back to COMPANY_EMAIL without a setting", async () => {
    await SiteContentModel.collection.deleteMany({});
    await makeUser({ accessExpiresAt: endsIn(2) });
    await run();
    expect(mail.digests[0]?.to).toBe(ENV_EMAIL);
  });

  it("is not sent when nobody was reminded", async () => {
    await makeUser({ accessExpiresAt: endsIn(20) });
    expect((await run()).digest).toBe("skipped");
    expect(mail.digests).toEqual([]);
  });

  it("is not sent when every reminder failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const user = await makeUser({ accessExpiresAt: endsIn(2) });
    mail.failFor.add(user.email);
    expect((await run()).digest).toBe("skipped");
    expect(mail.digests).toEqual([]);
  });

  it("no address at all → no_recipient; a failed digest is counted, not thrown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await SiteContentModel.collection.deleteMany({});
    vi.stubEnv("COMPANY_EMAIL", "");
    await makeUser({ accessExpiresAt: endsIn(2) });
    expect((await run()).digest).toBe("no_recipient");

    vi.stubEnv("COMPANY_EMAIL", ENV_EMAIL);
    mail.failDigest = 2;
    await makeUser({ accessExpiresAt: endsIn(3) });
    expect(await run()).toMatchObject({ sent: 1, digest: "failed" });
  });
});

describe("audit", () => {
  it("writes one actorless entry with counts only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const good = await makeUser({ accessExpiresAt: endsIn(2) });
    const bad = await makeUser({ accessExpiresAt: endsIn(3) });
    mail.failFor.add(bad.email);
    await run();

    const entries = await AuditLogModel.find({}).lean();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?.action).toBe("cron.expiry_reminders");
    expect(entry?.actor).toBeUndefined();
    expect(entry?.target).toBeUndefined();
    expect(entry?.meta).toEqual({
      due: 2,
      sent: 1,
      failed: 1,
      markFailed: 0,
      truncated: false,
      aborted: false,
      digest: "sent",
    });
    const json = JSON.stringify(entry);
    for (const secret of [
      good.email,
      bad.email,
      good.name,
      bad.name,
      good.id,
      bad.id,
      "@",
    ]) {
      expect(json).not.toContain(secret);
    }
  });
});

describe("dry run", () => {
  it("counts only: no email, no write, no audit, no lock", async () => {
    const user = await makeUser({ accessExpiresAt: endsIn(2) });
    await makeUser({ accessExpiresAt: endsIn(4) });

    const summary = await run({ dryRun: true });
    expect(summary).toMatchObject({
      dryRun: true,
      due: 2,
      sent: 0,
      digest: "skipped",
    });
    expect(mail.reminders).toEqual([]);
    expect(mail.digests).toEqual([]);
    expect((await rawUser(user.id))?.expiryReminderFor ?? null).toBeNull();
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expect(await LoginAttemptModel.countDocuments()).toBe(0);
  });
});

describe("concurrency and limits", () => {
  it("a run while another holds the lock does nothing", async () => {
    await makeUser({ accessExpiresAt: endsIn(2) });
    const key = buildKey(
      "cron-lock",
      createHash("sha256").update("expiry-reminders").digest("hex"),
    );
    const owner = await acquireLock(key, 60);
    expect(owner).not.toBeNull();
    try {
      expect(await run()).toMatchObject({ status: "busy", sent: 0 });
      expect(mail.reminders).toEqual([]);
      expect(await AuditLogModel.countDocuments()).toBe(0);
    } finally {
      await releaseLock(key, owner!);
    }
    // Released after a run, so the next run works.
    expect((await run()).sent).toBe(1);
    expect((await run()).status).toBe("completed");
  });

  it("two overlapping runs send each reminder once", async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeUser({ accessExpiresAt: endsIn(2 + i) });
    }
    const results = await Promise.all([run(), run()]);
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "completed"]);
    expect(mail.reminders).toHaveLength(3);
  });

  it("stops starting sends when the time budget runs out", async () => {
    await makeUser({ accessExpiresAt: endsIn(2) });
    const summary = await run({ budgetMs: 0 });
    expect(summary).toMatchObject({ due: 1, sent: 0, truncated: true });
    expect(mail.reminders).toEqual([]);
  });

  it("rejects invalid options (rule 8)", async () => {
    await expect(run({ batchSize: 0 })).rejects.toThrow();
    await expect(run({ now: new Date(Number.NaN) })).rejects.toThrow();
  });
});
