// QA gate B (Phase 5, P6): abuse of the ONE public Server Action,
// POST /request-access, through the REAL action and service on an in-memory
// MongoDB (the builders' action test mocks the service).
//
// 1. No enumeration: a new email, an existing customer's, the admin's, a
//    duplicate, a honeypot hit, a too-fast or future start time and a
//    limited sender all get the byte-identical state; field errors for the
//    same bad input are identical whether or not the email has an account.
// 2. Oversized and odd input: over-long fields are refused before the
//    service (no row, no limiter slot); control characters / header
//    injection are field errors; extra keys (status, source, user, role)
//    are ignored; a draft product is never stored.
// 3. No logging: no line carries a typed value on any path, outages
//    included.
// 4. Rule 4: the action never creates or changes an account.

import { ObjectId } from "mongodb";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  FORM_REFUSED,
  IDLE_STATE,
} from "@/components/site/request-access/request-form";
import { getDb } from "@/lib/db";
import { AccessRequestModel, ProductModel } from "@/models";
import { LoginAttemptModel } from "@/models/login-attempt";

import { setupMemoryDb } from "./helpers/memory-db";

const mocks = vi.hoisted(() => ({
  headers: new Headers(),
  background: [] as unknown[],
}));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => void mocks.background.push(task),
}));
const alerts = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendAccessRequestAlertEmail: vi.fn(async (input: Record<string, unknown>) => {
    alerts.push(input);
    return { id: "email-id" };
  }),
}));

setupMemoryDb("yg_phase5_gate_b_request_access");

const { requestAccessAction } =
  await import("@/app/(site)/request-access/actions");

const CUSTOMER_EMAIL = "known-customer@gate-b-ra.test";
const ADMIN_EMAIL = "the-admin@gate-b-ra.test";
const SECRET = "project-codename-ZEBRA-42";
let ipCounter = 1;
let emailCounter = 0;
let draftId = "";
const lines: string[] = [];

beforeAll(async () => {
  await Promise.all([
    LoginAttemptModel.createIndexes(),
    AccessRequestModel.createIndexes(),
  ]);
  const now = new Date();
  await getDb()
    .collection("users")
    .insertMany([
      {
        email: CUSTOMER_EMAIL,
        name: "Known",
        role: "customer",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        email: ADMIN_EMAIL,
        name: "Admin",
        role: "admin",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
    ]);
  const draft = new ObjectId();
  draftId = draft.toHexString();
  await ProductModel.collection.insertOne({
    _id: draft,
    name: "QA Draft Unreleased",
    slug: `qa-draft-${draftId}`,
    status: "draft",
    variants: [{ modelNo: `QA-DRAFT-${draftId.slice(-6)}` }],
  });
});

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", "gate-b-request-test-secret-0123456789abcdef");
  vi.stubEnv("IP_HASH_SECRET", "gate-b-request-ip-secret-0123456789abcdefg");
  vi.stubEnv("COMPANY_EMAIL", "office@yg.example");
  mocks.headers = new Headers({
    "x-vercel-forwarded-for": `198.51.100.${ipCounter++ % 250}`,
  });
  mocks.background = [];
  alerts.length = 0;
  lines.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  await Promise.all([
    LoginAttemptModel.deleteMany({}),
    AccessRequestModel.deleteMany({}),
  ]);
});

afterEach(async () => {
  await Promise.all(mocks.background as Promise<unknown>[]);
  vi.restoreAllMocks();
  // Nothing typed into the form ever reaches a log line.
  expect(lines.join("\n")).not.toMatch(
    /gate-b-ra\.test|ZEBRA|Ada Byron|Acme Optics/,
  );
});

const nextEmail = () => `visitor-${++emailCounter}@gate-b-ra.test`;

function post(fields: Record<string, string | string[] | Blob> = {}): FormData {
  const data = new FormData();
  const all: Record<string, string | string[] | Blob> = {
    name: "Ada Byron",
    email: nextEmail(),
    company: "Acme Optics",
    country: "Japan",
    message: SECRET,
    consent: "on",
    kind: "new",
    website: "",
    startedAt: String(Date.now() - 60_000),
    ...fields,
  };
  for (const [key, value] of Object.entries(all)) {
    for (const item of Array.isArray(value) ? value : [value])
      data.append(key, item);
  }
  return data;
}

const submit = (data: FormData) => requestAccessAction(IDLE_STATE, data);
const rows = () => AccessRequestModel.find({}).lean().exec();
const users = () =>
  getDb()
    .collection("users")
    .find({}, { projection: { _id: 0, email: 1, role: 1, updatedAt: 1 } })
    .toArray();

describe("identical answers (no account enumeration)", () => {
  it("every accepted, dropped or limited submission gets the same state", async () => {
    const reference = await submit(post());
    expect(reference).toMatchObject({ status: "sent" });
    const duplicateEmail = nextEmail();
    await submit(post({ email: duplicateEmail }));

    const states = [
      await submit(post({ email: CUSTOMER_EMAIL })),
      await submit(post({ email: ADMIN_EMAIL })),
      await submit(post({ email: duplicateEmail })),
      await submit(post({ website: "https://spam.example" })),
      await submit(post({ startedAt: String(Date.now()) })),
      await submit(post({ startedAt: String(Date.now() + 3_600_000) })),
      await submit(post({ startedAt: "" })),
    ];
    // The network limit (5 / 15 min) from one address: the 6th+ are dropped.
    mocks.headers = new Headers({ "x-vercel-forwarded-for": "192.0.2.99" });
    for (let i = 0; i < 7; i++) states.push(await submit(post()));
    for (const state of states) expect(state).toEqual(reference);
  });

  it("field errors for the same bad input do not depend on whether the email has an account", async () => {
    const bad = {
      name: "",
      company: "<b>",
      country: "Atlantis",
      startedAt: String(Date.now() - 60_000),
    };
    const known = await submit(post({ ...bad, email: CUSTOMER_EMAIL }));
    const admin = await submit(post({ ...bad, email: ADMIN_EMAIL }));
    const unknown = await submit(
      post({ ...bad, email: "nobody@gate-b-ra.test" }),
    );
    const strip = (state: unknown) => {
      const copy = structuredClone(state) as { values?: { email?: string } };
      delete copy.values?.email;
      return copy;
    };
    expect(known).toMatchObject({ status: "invalid" });
    expect(strip(known)).toEqual(strip(unknown));
    expect(strip(admin)).toEqual(strip(unknown));
  });

  it("never creates or changes an account (rule 4)", async () => {
    const before = JSON.stringify(await users());
    await submit(post({ email: CUSTOMER_EMAIL }));
    await submit(post({ email: "brand-new@gate-b-ra.test" }));
    expect(JSON.stringify(await users())).toBe(before);
  });
});

describe("oversized and odd input", () => {
  it("a field over 20,000 characters is refused before the service: no row, no limiter slot", async () => {
    const state = await submit(post({ message: "x".repeat(20_001) }));
    expect(state).toMatchObject({ status: "invalid", formError: FORM_REFUSED });
    expect(await rows()).toHaveLength(0);
    expect(await LoginAttemptModel.countDocuments({})).toBe(0);
    // An over-long honeypot or start time too.
    for (const key of ["website", "startedAt", "product", "kind"]) {
      expect(await submit(post({ [key]: "9".repeat(20_001) }))).toMatchObject({
        formError: FORM_REFUSED,
      });
    }
    expect(await rows()).toHaveLength(0);
  });

  it("long but under the raw cap: a field error from the schema, nothing stored", async () => {
    for (const field of ["name", "company", "message", "phone", "email"]) {
      const state = await submit(post({ [field]: "a".repeat(19_999) }));
      expect(state, field).toMatchObject({ status: "invalid" });
    }
    expect(await rows()).toHaveLength(0);
  });

  it("header injection, control characters and markup in single-line fields are field errors", async () => {
    for (const [field, value] of [
      ["name", "Ada\r\nBcc: victim@example.com"],
      ["name", "Ada\u0000Byron"],
      ["company", "Acme <script>alert(1)</script>"],
      ["email", "ada@example.com\r\nBcc: x@y.z"],
      ["email", "ada@example.com,other@example.com"],
      ["country", "Japan\nChina"],
    ] as const) {
      const state = await submit(post({ [field]: value }));
      expect(state, `${field}: ${JSON.stringify(value)}`).toMatchObject({
        status: "invalid",
      });
    }
    expect(await rows()).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it("extra keys cannot set status, source, user or role; a repeated key uses the first value", async () => {
    const email = nextEmail();
    const data = post({ email });
    for (const [key, value] of <[string, string][]>[
      ["status", "approved"],
      ["source", "whatsapp"],
      ["user", new ObjectId().toHexString()],
      ["role", "admin"],
      ["handledAt", "2026-01-01"],
      ["email", "second@gate-b-ra.test"],
    ]) {
      data.append(key, value);
    }
    expect(await submit(data)).toMatchObject({ status: "sent" });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      email,
      status: "pending",
      source: "form",
    });
    expect(stored[0]?.user).toBeUndefined();
    expect(stored[0]?.handledAt ?? null).toBeNull();
  });

  it("a file in a text field is dropped; a file as the honeypot counts as filled", async () => {
    const file = new File(["bin"], "x.exe", {
      type: "application/octet-stream",
    });
    const asName = await submit(post({ name: file }));
    expect(asName).toMatchObject({ status: "invalid" });
    const asHoneypot = await submit(post({ website: file }));
    expect(asHoneypot).toMatchObject({ status: "sent" });
    expect(await rows()).toHaveLength(0);
  });

  it("a draft, unknown or malformed product id is never stored; a malformed kind is refused", async () => {
    for (const product of [draftId, new ObjectId().toHexString()]) {
      expect(await submit(post({ product }))).toMatchObject({ status: "sent" });
    }
    const stored = await rows();
    expect(stored).toHaveLength(2);
    for (const row of stored) expect(row.product ?? null).toBeNull();
    // A malformed product is dropped by design (ADR 0074), never queried.
    expect(await submit(post({ product: '{"$ne":null}' }))).toMatchObject({
      status: "sent",
    });
    for (const row of await rows()) expect(row.product ?? null).toBeNull();
    expect(await submit(post({ kind: "admin" }))).toMatchObject({
      status: "invalid",
      formError: FORM_REFUSED,
    });
  });

  it("the company alert carries no message, email or phone", async () => {
    expect(await submit(post({ phone: "+44 20 7946 0000" }))).toMatchObject({
      status: "sent",
    });
    await Promise.all(mocks.background as Promise<unknown>[]);
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(alerts[0])).not.toMatch(/ZEBRA|gate-b-ra\.test|7946/);
  });
});

describe("outages", () => {
  it("a database failure answers unavailable, keeps the typed values, logs no value", async () => {
    const spy = vi
      .spyOn(AccessRequestModel, "updateOne")
      .mockImplementation(() => {
        throw new Error(
          `E11000 duplicate key { email: "leak@gate-b-ra.test" } ${SECRET}`,
        );
      });
    const state = await submit(post());
    spy.mockRestore();
    expect(state).toMatchObject({ status: "unavailable" });
    // afterEach checks the log lines.
  });
});
