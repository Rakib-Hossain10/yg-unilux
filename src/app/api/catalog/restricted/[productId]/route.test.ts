// Tests for GET /api/catalog/restricted/[productId] (P7): the viewer matrix
// (session mocked, database real in memory), the datasheet button state, the
// 400/404 answers, `private, no-store` on every answer, and that a refused
// viewer gets no restricted value and nobody gets a datasheet id or key.

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProductModel } from "@/models";
import {
  DEFAULT_RESTRICTED_SPEC_KEYS,
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";
import { setupMemoryDb } from "../../../../../../test/helpers/memory-db";
import { testPublicId } from "../../../../../../test/helpers/public-ids";

import { GET } from "./route";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));

setupMemoryDb("yg_restricted_route_test");

const DAY = 86_400_000;
const token = (key: SpecKey) => `TOKEN-${key}-`;
const ALL_SPECS: SpecValues = Object.fromEntries(
  SPEC_KEYS.map((key) => [key, [token(key)]]),
);

const ids = {
  category: new Types.ObjectId(),
  withSheet: new Types.ObjectId(),
  noSheet: new Types.ObjectId(),
  draft: new Types.ObjectId(),
  datasheet: new Types.ObjectId(),
};

beforeAll(async () => {
  const base = {
    mainCategory: ids.category,
    status: "published" as const,
    specs: ALL_SPECS,
    images: [{ publicId: testPublicId(1), order: 0, kind: "gallery" as const }],
  };
  await ProductModel.create([
    {
      ...base,
      _id: ids.withSheet,
      name: "Arc",
      slug: "arc-ar-013a",
      variants: [{ modelNo: "AR-013A1" }, { modelNo: "AR-013A2" }],
      datasheetId: ids.datasheet,
    },
    {
      ...base,
      _id: ids.noSheet,
      name: "Solo",
      slug: "solo-so-001",
      variants: [{ modelNo: "SO-001" }],
    },
    {
      ...base,
      _id: ids.draft,
      name: "Draft",
      slug: "draft-dr-001",
      status: "draft" as const,
      variants: [{ modelNo: "DR-001" }],
      datasheetId: ids.datasheet,
    },
  ]);
});

beforeEach(() => {
  getSession.mockReset();
});

function signedInAs(fields: Record<string, unknown> | null): void {
  getSession.mockResolvedValue(
    fields === null
      ? null
      : {
          session: { id: "s1" },
          user: {
            id: "u1",
            role: "customer",
            banned: false,
            banExpires: null,
            mustChangePassword: false,
            accessExpiresAt: null,
            ...fields,
          },
        },
  );
}

async function call(productId: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/catalog/restricted/${productId}`),
    {
      params: Promise.resolve({ productId }),
    },
  );
}

function expectNoLeak(text: string): void {
  for (const key of SPEC_KEYS) expect(text).not.toContain(token(key));
  expect(text).not.toContain(ids.datasheet.toHexString());
  expect(text).not.toMatch(/storageKey|datasheetId|https?:/);
}

const withSheet = ids.withSheet.toHexString();
const noSheet = ids.noSheet.toHexString();

describe("GET /api/catalog/restricted/[productId]: refused viewers", () => {
  it.each<[string, Record<string, unknown> | null, string]>([
    ["a visitor", null, "signin"],
    [
      "a customer on a temporary password",
      { mustChangePassword: true },
      "signin",
    ],
    ["a user with another role", { role: "staff" }, "signin"],
    [
      "a customer whose access expired",
      { accessExpiresAt: new Date(Date.now() - 1000) },
      "expired",
    ],
    [
      "a customer whose access ends right now",
      { accessExpiresAt: new Date() },
      "expired",
    ],
    ["a banned customer", { banned: true }, "expired"],
    ["a banned admin", { role: "admin", banned: true }, "expired"],
  ])(
    "answers %s with allowed:false and no data",
    async (_label, fields, state) => {
      signedInAs(fields);
      const response = await call(withSheet);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ allowed: false, state });
      expectNoLeak(text);
    },
  );

  it("shows coming-soon to a visitor when there is no datasheet", async () => {
    signedInAs(null);
    const response = await call(noSheet);
    expect(await response.json()).toEqual({
      allowed: false,
      state: "coming-soon",
    });
  });

  it("shows coming-soon to an expired customer when there is no datasheet", async () => {
    signedInAs({ accessExpiresAt: new Date(Date.now() - DAY) });
    expect(await (await call(noSheet)).json()).toEqual({
      allowed: false,
      state: "coming-soon",
    });
  });
});

describe("GET /api/catalog/restricted/[productId]: allowed viewers", () => {
  it.each<[string, Record<string, unknown>]>([
    ["an active customer with no expiry", {}],
    [
      "a customer whose access ends tomorrow",
      { accessExpiresAt: new Date(Date.now() + DAY) },
    ],
    ["the admin", { role: "admin" }],
    [
      "the admin with a past expiry date",
      { role: "admin", accessExpiresAt: new Date(Date.now() - DAY) },
    ],
  ])(
    "sends %s the restricted values and the download state",
    async (_label, fields) => {
      signedInAs(fields);
      const response = await call(withSheet);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const text = await response.text();
      const restrictedSpecs = Object.fromEntries(
        DEFAULT_RESTRICTED_SPEC_KEYS.map((key) => [key, [token(key)]]),
      );
      expect(JSON.parse(text)).toEqual({
        allowed: true,
        state: "download",
        keys: [...DEFAULT_RESTRICTED_SPEC_KEYS],
        specs: restrictedSpecs,
        variants: [
          { modelNo: "AR-013A1", specs: restrictedSpecs },
          { modelNo: "AR-013A2", specs: restrictedSpecs },
        ],
      });
      // Only restricted columns, never the datasheet's id or a URL.
      const publicKeys = SPEC_KEYS.filter(
        (key) => !DEFAULT_RESTRICTED_SPEC_KEYS.includes(key),
      );
      for (const key of publicKeys) expect(text).not.toContain(token(key));
      expect(text).not.toContain(ids.datasheet.toHexString());
      expect(text).not.toMatch(/storageKey|datasheetId|https?:/);
    },
  );

  it("sends coming-soon with the values when there is no datasheet", async () => {
    signedInAs({});
    const body = (await (await call(noSheet)).json()) as {
      allowed: boolean;
      state: string;
      keys: string[];
    };
    expect(body.allowed).toBe(true);
    expect(body.state).toBe("coming-soon");
    expect(body.keys).toEqual([...DEFAULT_RESTRICTED_SPEC_KEYS]);
  });
});

describe("GET /api/catalog/restricted/[productId]: bad ids", () => {
  it.each(["", "xyz", "z".repeat(24), `${withSheet}0`, "{}", "$where"])(
    "answers 400 for %j without reading the session",
    async (bad) => {
      signedInAs({ role: "admin" });
      const response = await call(bad);
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ message: "Invalid product id." });
      expect(getSession).not.toHaveBeenCalled();
    },
  );

  it("accepts an upper-case id", async () => {
    signedInAs({ role: "admin" });
    const body = (await (await call(withSheet.toUpperCase())).json()) as {
      allowed: boolean;
    };
    expect(body.allowed).toBe(true);
  });

  it.each<[string, string]>([
    ["an unknown product", new Types.ObjectId().toHexString()],
    ["a draft product", ids.draft.toHexString()],
  ])("answers 404 for %s, even to the admin", async (_label, id) => {
    for (const fields of [null, { role: "admin" }]) {
      signedInAs(fields);
      const response = await call(id);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ message: "Product not found." });
      expectNoLeak(text);
    }
  });

  it("propagates a session read failure instead of answering", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    await expect(call(withSheet)).rejects.toThrow("db down");
  });
});
