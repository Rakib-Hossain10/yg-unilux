// Tests for GET /api/catalog/search (ADR 0066) on an in-memory MongoDB (the
// regex fallback): Zod bounds and 400 cases, the empty answer under 2
// characters, `private, max-age=30` on answers, no session read, no query
// text in error logs, and no spec value in the JSON.

import { Types } from "mongoose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CategoryModel, ProductModel } from "@/models";
import { SPEC_KEYS, type SpecValues } from "@/models/spec-columns";
import { setupMemoryDb } from "../../../../../test/helpers/memory-db";

const session = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSessionFromDb: session.read }));
vi.mock("@/lib/permissions", () => ({ getViewer: session.read }));
vi.mock("next/headers", () => ({
  headers: async () => {
    session.read();
    return new Headers();
  },
  cookies: async () => {
    session.read();
    return new Map();
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/cache", () => ({
  unstable_cache:
    (fn: (...args: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) =>
      fn(...args),
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
}));

import * as search from "@/lib/catalog/search";

import { GET } from "./route";

setupMemoryDb("yg_search_route_test");

const ALL_SPECS: SpecValues = Object.fromEntries(
  SPEC_KEYS.map((key) => [key, [`SPECVAL-${key}`]]),
);
const category = new Types.ObjectId();

beforeAll(async () => {
  await CategoryModel.create({
    _id: category,
    name: "Spot Lights",
    slug: "spot-lights",
    parent: null,
    order: 0,
  });
  await ProductModel.create([
    {
      mainCategory: category,
      status: "published",
      name: "Arc Spot",
      slug: "arc-ar-013a",
      family: "Arc",
      modelCode: "AR-013A",
      specs: ALL_SPECS,
      variants: [
        { modelNo: "AR-013A1", label: "Lens", specs: ALL_SPECS },
        { modelNo: "AR-013A2", specs: ALL_SPECS },
      ],
      datasheetId: new Types.ObjectId(),
    },
    {
      mainCategory: category,
      status: "draft",
      name: "Arc Draft",
      slug: "arc-draft",
      variants: [{ modelNo: "AR-0130" }],
    },
  ]);
});

beforeEach(() => {
  session.read.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

const get = (query: string) =>
  GET(new Request(`https://example.test/api/catalog/search${query}`));

describe("GET /api/catalog/search", () => {
  it("answers hits with `private, max-age=30` and no session read", async () => {
    const response = await get("?q=ar-013a2");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=30");
    const body = (await response.json()) as search.SearchResult;
    expect(body.query).toBe("ar-013a2");
    expect(body.products.map((p) => [p.slug, p.matchedModelNo])).toEqual([
      ["arc-ar-013a", "AR-013A2"],
    ]);
    expect(body.categories).toEqual([]);
    expect(session.read).not.toHaveBeenCalled();
  });

  it("finds categories with their path", async () => {
    const body = (await (await get("?q=spot")).json()) as search.SearchResult;
    expect(body.categories).toEqual([
      {
        id: category.toHexString(),
        name: "Spot Lights",
        slug: "spot-lights",
        path: ["Spot Lights"],
        slugPath: ["spot-lights"],
      },
    ]);
  });

  it.each(["", "?q=", "?q=a", "?q=%20a%20", "?other=1"])(
    "answers an empty 200 for %j (under 2 characters)",
    async (query) => {
      const response = await get(query);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        query: "",
        products: [],
        categories: [],
      });
    },
  );

  it("accepts 64 characters and rejects 65 (after trimming)", async () => {
    expect((await get(`?q=${"x".repeat(64)}`)).status).toBe(200);
    expect((await get(`?q=%20%20${"x".repeat(64)}%20%20`)).status).toBe(200);
    const tooLong = await get(`?q=${"x".repeat(65)}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    ["a repeated q", "?q=arc&q=bolt"],
    ["a raw q over 256 characters", `?q=${"%20".repeat(300)}ab`],
    ["a huge q", `?q=${"x".repeat(5000)}`],
  ])("answers 400 for %s", async (_name, query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid search query." });
  });

  it("never returns drafts or spec values", async () => {
    for (const q of ["ar", "arc", "AR-013", "ar-0130", "SPECVAL"]) {
      const text = await (await get(`?q=${encodeURIComponent(q)}`)).text();
      expect(text, q).not.toContain("SPECVAL-");
      expect(text, q).not.toContain("arc-draft");
      expect(text, q).not.toMatch(/"(specs|label|datasheetId|variants)"/);
    }
  });

  it("answers a generic 500 without logging the query", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(search, "searchCatalog").mockRejectedValueOnce(
      new Error("boom with private-query-text"),
    );
    const response = await get("?q=private-query-text");
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      message: "Search is unavailable. Please try again.",
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "private-query-text",
    );
  });
});
