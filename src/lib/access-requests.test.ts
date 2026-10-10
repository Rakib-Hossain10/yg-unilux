// Tests for the public submission (src/lib/access-requests.ts, ADR 0069) on
// an in-memory MongoDB: the SAME answer for new, duplicate, existing
// customer, limited, honeypot and too-fast submissions; the limits; the
// one-pending-per-email merge (latest submission wins whole); the alert
// only for new rows and without the message; validation; outages.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessRequestModel, ProductModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  ACCESS_REQUEST_STALE,
  MIN_FILL_MS,
  submitAccessRequest,
  type SubmitAccessRequestContext,
} from "./access-requests";
import { FORM_STAMP_MAX_AGE_MS, issueFormStamp } from "./form-stamp";

const alerts = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./email")>()),
  sendAccessRequestAlertEmail: vi.fn(async (input: Record<string, unknown>) => {
    alerts.push(input);
    return { id: "email-id" };
  }),
}));

setupMemoryDb("yg_access_requests_public_test");

const NOW = new Date("2026-10-09T12:00:00.000Z");
const COMPANY = "office@yg.example";
let ipCounter = 1;
let emailCounter = 0;
let background: Promise<unknown>[] = [];

beforeAll(async () => {
  await Promise.all([
    LoginAttemptModel.createIndexes(),
    AccessRequestModel.createIndexes(),
  ]);
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", "public-request-test-secret-0123456789abcdef");
  vi.stubEnv("IP_HASH_SECRET", "public-request-ip-secret-0123456789abcdefg");
  vi.stubEnv("COMPANY_EMAIL", COMPANY);
  alerts.length = 0;
  background = [];
  await Promise.all([
    LoginAttemptModel.deleteMany({}),
    AccessRequestModel.deleteMany({}),
  ]);
});

const nextEmail = () => `visitor-${++emailCounter}@example.com`;

function context(
  extra: Partial<SubmitAccessRequestContext> = {},
  ip = `198.51.100.${ipCounter++ % 250}`,
): SubmitAccessRequestContext {
  return {
    headers: new Headers({ "x-vercel-forwarded-for": ip }),
    now: NOW,
    runInBackground: (task) => void background.push(task),
    ...extra,
  };
}

function form(fields: Record<string, unknown> = {}) {
  return {
    name: "Jane Doe",
    email: nextEmail(),
    company: "Acme Lighting",
    country: "Hong Kong",
    consent: "on",
    startedAt: stampAgo(10_000),
    website: "",
    ...fields,
  };
}

const settle = () => Promise.all(background);

/* A stamp this server issued `ms` before NOW (negative: after NOW). */
const stampAgo = (ms: number) => issueFormStamp(new Date(NOW.getTime() - ms));

describe("identical answers", () => {
  it("new, duplicate, existing customer, limited, honeypot and too fast all answer { ok: true }", async () => {
    const email = nextEmail();
    const answers = [
      await submitAccessRequest(form({ email }), context()),
      await submitAccessRequest(form({ email }), context()),
      await submitAccessRequest(
        form({ email }),
        context({
          viewer: { userId: "a".repeat(24), email, role: "customer" },
        }),
      ),
      await submitAccessRequest(form({ website: "spam.example" }), context()),
      await submitAccessRequest(
        form({ startedAt: stampAgo(MIN_FILL_MS - 1) }),
        context(),
      ),
      await submitAccessRequest(form({ startedAt: undefined }), context()),
      await submitAccessRequest(
        form({ startedAt: stampAgo(-60_000) }),
        context(),
      ),
    ];
    // Use up the per-email limit (3 per day): the 4th is silently dropped.
    answers.push(await submitAccessRequest(form({ email }), context()));
    for (const answer of answers) expect(answer).toStrictEqual({ ok: true });
  });

  it("honeypot and too-fast submissions store nothing and count nothing", async () => {
    await submitAccessRequest(form({ website: "x" }), context());
    await submitAccessRequest(form({ startedAt: stampAgo(100) }), context());
    await submitAccessRequest(form({ website: ["x"] }), context());
    expect(await AccessRequestModel.countDocuments()).toBe(0);
    expect(await LoginAttemptModel.countDocuments()).toBe(0);
    await settle();
    expect(alerts).toHaveLength(0);
  });
});

describe("signed start stamp (QA gate B L-1)", () => {
  /* Swap the first MAC character for another valid one. */
  const tamper = (stamp: string) => {
    const dot = stamp.indexOf(".");
    const first = stamp[dot + 1] === "A" ? "B" : "A";
    return `${stamp.slice(0, dot + 1)}${first}${stamp.slice(dot + 2)}`;
  };

  it.each([
    ["a forged plain number (the old startedAt=1)", () => "1"],
    ["a plain number from long ago", () => String(NOW.getTime() - 60_000)],
    ["a tampered MAC", () => tamper(stampAgo(60_000))],
    [
      "a MAC moved onto an earlier time",
      () => `${NOW.getTime() - 60_000}.${stampAgo(10).split(".")[1]}`,
    ],
    [
      "a forged stamp from long ago",
      () =>
        `${NOW.getTime() - FORM_STAMP_MAX_AGE_MS - 1}.${stampAgo(10).split(".")[1]}`,
    ],
    ["a stamp from the future", () => stampAgo(-1)],
    ["a too-fast stamp", () => stampAgo(MIN_FILL_MS - 1)],
    ["an empty stamp", () => ""],
  ])(
    "%s is thanked and dropped: no row, no limiter slot, no alert",
    async (_label, stamp) => {
      const answer = await submitAccessRequest(
        form({ startedAt: stamp() }),
        context(),
      );
      expect(answer).toStrictEqual({ ok: true });
      expect(await AccessRequestModel.countDocuments()).toBe(0);
      expect(await LoginAttemptModel.countDocuments()).toBe(0);
      await settle();
      expect(alerts).toHaveLength(0);
    },
  );

  it("a genuine stamp over 24 h old asks to reload: no row, no limiter slot", async () => {
    const answer = await submitAccessRequest(
      form({ startedAt: stampAgo(FORM_STAMP_MAX_AGE_MS + 1) }),
      context(),
    );
    expect(answer).toStrictEqual({
      ok: false,
      errors: { formErrors: [ACCESS_REQUEST_STALE], fieldErrors: {} },
    });
    expect(await AccessRequestModel.countDocuments()).toBe(0);
    expect(await LoginAttemptModel.countDocuments()).toBe(0);
  });

  it("the stale answer is the same for a customer's email and a new one", async () => {
    const stale = stampAgo(FORM_STAMP_MAX_AGE_MS + 60_000);
    const email = nextEmail();
    const known = await submitAccessRequest(
      form({ email, startedAt: stale }),
      context({ viewer: { userId: "a".repeat(24), email, role: "customer" } }),
    );
    const unknown = await submitAccessRequest(
      form({ startedAt: stale }),
      context(),
    );
    expect(known).toStrictEqual(unknown);
  });

  it("a valid stamp at the minimum fill time and one just under 24 h are stored", async () => {
    await submitAccessRequest(
      form({ startedAt: stampAgo(MIN_FILL_MS) }),
      context(),
    );
    await submitAccessRequest(
      form({ startedAt: stampAgo(FORM_STAMP_MAX_AGE_MS) }),
      context(),
    );
    expect(await AccessRequestModel.countDocuments()).toBe(2);
  });

  it("a missing AUTH_SECRET is our outage, not a silent drop", async () => {
    const valid = form();
    vi.stubEnv("AUTH_SECRET", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = await submitAccessRequest(valid, context());
    expect(answer).toStrictEqual({ ok: false, unavailable: true });
    expect(JSON.stringify(errors.mock.calls)).toContain("EnvError");
    errors.mockRestore();
    expect(await AccessRequestModel.countDocuments()).toBe(0);
  });
});

describe("storing and merging", () => {
  it("stores a new pending request with consent and kind, and alerts once", async () => {
    const email = nextEmail();
    await submitAccessRequest(
      form({
        email: ` ${email.toUpperCase()} `,
        kind: "renewal",
        message: "Hi",
      }),
      context(),
    );
    const doc = await AccessRequestModel.findOne({ email }).lean();
    expect(doc).toMatchObject({
      name: "Jane Doe",
      company: "Acme Lighting",
      country: "Hong Kong",
      status: "pending",
      source: "form",
      kind: "renewal",
      message: "Hi",
      consentAt: NOW,
    });
    await settle();
    expect(alerts).toEqual([
      {
        to: COMPANY,
        name: "Jane Doe",
        company: "Acme Lighting",
        country: "Hong Kong",
        kind: "renewal",
      },
    ]);
    // Never the message, email or phone.
    expect(JSON.stringify(alerts)).not.toMatch(/Hi"|@example\.com/);
  });

  it("a second submission merges into the pending one (latest wins whole), no new alert", async () => {
    const email = nextEmail();
    const product = await ProductModel.collection.insertOne({
      name: "Arc",
      slug: "arc",
      status: "published",
    });
    await submitAccessRequest(
      form({
        email,
        phone: "+852 9123 4567",
        message: "First",
        product: product.insertedId.toHexString(),
      }),
      context(),
    );
    await submitAccessRequest(
      form({ email, name: "Janet Doe", company: "Other Co" }),
      context(),
    );
    const docs = await AccessRequestModel.find({ email }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ name: "Janet Doe", company: "Other Co" });
    expect(docs[0]?.phone).toBeUndefined();
    expect(docs[0]?.message).toBeUndefined();
    expect(docs[0]?.product).toBeUndefined();
    await settle();
    expect(alerts).toHaveLength(1);
  });

  it("racing submissions for a new email still give one row", async () => {
    const email = nextEmail();
    const answers = await Promise.all(
      [1, 2, 3].map(() => submitAccessRequest(form({ email }), context())),
    );
    for (const answer of answers) expect(answer).toStrictEqual({ ok: true });
    expect(await AccessRequestModel.countDocuments({ email })).toBe(1);
  });

  it("never merges into the admin's manual WhatsApp entry (same answer, nothing changed)", async () => {
    const email = nextEmail();
    await AccessRequestModel.create({
      name: "Chat Person",
      email,
      phone: "+852 9123 4567",
      message: "Typed by the admin",
      source: "whatsapp",
    });
    const answer = await submitAccessRequest(
      form({ email, name: "Someone Else" }),
      context(),
    );
    expect(answer).toStrictEqual({ ok: true });
    const docs = await AccessRequestModel.find({ email }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      name: "Chat Person",
      phone: "+852 9123 4567",
      message: "Typed by the admin",
      source: "whatsapp",
    });
    expect(docs[0]?.consentAt).toBeUndefined();
    await settle();
    expect(alerts).toHaveLength(0);
  });

  it("an anonymous submission never overwrites a row linked to a customer; the customer can", async () => {
    const email = nextEmail();
    const userId = "c".repeat(24);
    const viewer = { userId, email, role: "customer" };
    await submitAccessRequest(
      form({ email, kind: "renewal", message: "Mine" }),
      context({ viewer }),
    );
    expect(
      await submitAccessRequest(
        form({ email, name: "Intruder Person" }),
        context(),
      ),
    ).toStrictEqual({ ok: true });
    let doc = await AccessRequestModel.findOne({ email }).lean();
    expect(doc).toMatchObject({ name: "Jane Doe", message: "Mine" });
    expect(doc?.user?.toHexString()).toBe(userId);

    await submitAccessRequest(
      form({ email, name: "Jane Updated" }),
      context({ viewer }),
    );
    doc = await AccessRequestModel.findOne({ email }).lean();
    expect(doc?.name).toBe("Jane Updated");
    expect(doc?.user?.toHexString()).toBe(userId);
  });

  it("a handled request doesn't block a new pending one", async () => {
    const email = nextEmail();
    await AccessRequestModel.create({
      name: "Old",
      email,
      source: "form",
      status: "approved",
    });
    await submitAccessRequest(form({ email }), context());
    expect(await AccessRequestModel.countDocuments({ email })).toBe(2);
  });

  it("links the account only for a customer using their own email", async () => {
    const own = nextEmail();
    const userId = "b".repeat(24);
    await submitAccessRequest(
      form({ email: own }),
      context({
        viewer: { userId, email: own.toUpperCase(), role: "customer" },
      }),
    );
    expect(
      (
        await AccessRequestModel.findOne({ email: own }).lean()
      )?.user?.toHexString(),
    ).toBe(userId);

    const other = nextEmail();
    await submitAccessRequest(
      form({ email: other }),
      context({ viewer: { userId, email: own, role: "customer" } }),
    );
    expect(
      (await AccessRequestModel.findOne({ email: other }).lean())?.user,
    ).toBeUndefined();

    const adminEmail = nextEmail();
    await submitAccessRequest(
      form({ email: adminEmail }),
      context({ viewer: { userId, email: adminEmail, role: "admin" } }),
    );
    expect(
      (await AccessRequestModel.findOne({ email: adminEmail }).lean())?.user,
    ).toBeUndefined();
  });

  it("keeps a product only when it is a published product", async () => {
    const draft = await ProductModel.collection.insertOne({
      name: "Draft",
      slug: "draft",
      status: "draft",
    });
    const email = nextEmail();
    await submitAccessRequest(
      form({ email, product: draft.insertedId.toHexString() }),
      context(),
    );
    const malformed = nextEmail();
    await submitAccessRequest(
      form({ email: malformed, product: "{$gt:''}" }),
      context(),
    );
    expect(
      (await AccessRequestModel.findOne({ email }).lean())?.product,
    ).toBeUndefined();
    expect(
      (await AccessRequestModel.findOne({ email: malformed }).lean())?.product,
    ).toBeUndefined();
  });
});

describe("limits", () => {
  it("one network gets 5 per 15 minutes across emails; the rest store nothing", async () => {
    const ip = "192.0.2.77";
    for (let i = 0; i < 7; i++) {
      expect(await submitAccessRequest(form(), context({}, ip))).toStrictEqual({
        ok: true,
      });
    }
    expect(await AccessRequestModel.countDocuments()).toBe(5);
  });

  it("one email gets 3 per day across networks", async () => {
    const email = nextEmail();
    for (let i = 0; i < 5; i++) {
      await submitAccessRequest(
        form({ email, message: `try ${i}` }),
        context(),
      );
    }
    const doc = await AccessRequestModel.findOne({ email }).lean();
    // The 4th and 5th were dropped, so the merge stopped at the 3rd.
    expect(doc?.message).toBe("try 2");
  });
});

describe("validation and outages", () => {
  it("field errors for invalid input (the visitor's own typing only)", async () => {
    const answer = await submitAccessRequest(
      form({
        name: "http://evil.example",
        email: "nope",
        company: "",
        country: "<b>",
        consent: undefined,
      }),
      context(),
    );
    expect(answer.ok).toBe(false);
    if (answer.ok || !("errors" in answer)) throw new Error("expected errors");
    expect(Object.keys(answer.errors.fieldErrors).sort()).toEqual([
      "company",
      "consent",
      "country",
      "email",
      "name",
    ]);
    expect(await LoginAttemptModel.countDocuments()).toBe(0);
  });

  it("answers unavailable when the limiter's database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(LoginAttemptModel, "findOneAndUpdate").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await submitAccessRequest(form(), context())).toStrictEqual({
      ok: false,
      unavailable: true,
    });
  });

  it("answers unavailable when the request can't be stored; logs no address", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(AccessRequestModel, "updateOne").mockImplementation(() => {
      throw new Error("write failed for visitor@example.com");
    });
    expect(await submitAccessRequest(form(), context())).toStrictEqual({
      ok: false,
      unavailable: true,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain("@");
  });
});
