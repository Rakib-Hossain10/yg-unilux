// Tests for getCounts() (src/lib/admin/dashboard.ts) on an in-memory MongoDB:
// every dashboard number matches a known seed, an empty database gives all
// zeros, and only counts come back (never document content).

import { beforeEach, describe, expect, it, vi } from "vitest";

import { XLSX_MIME_TYPE } from "@/lib/constants";
import { getDb, mongoose } from "@/lib/db";
import {
  AccessRequestModel,
  AreaModel,
  CategoryModel,
  DatasheetModel,
  ProductModel,
  WhistleblowerCaseModel,
} from "@/models";
import type { ProductStatus } from "@/models/product";
import type { CaseStatus } from "@/models/whistleblower-case";
import { testActor } from "../../../test/helpers/admin-actor";
import { setupMemoryDb } from "../../../test/helpers/memory-db";

import { getCounts, type DashboardCounts } from "./dashboard";

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: (await import("../../../test/helpers/admin-actor"))
    .fakeSessionFromDb,
}));

setupMemoryDb("yg_dashboard_test");
const admin = testActor();

const { ObjectId } = mongoose.Types;

const ZERO_COUNTS: DashboardCounts = {
  products: { total: 0, published: 0, draft: 0 },
  categories: { main: 0, sub: 0 },
  areas: 0,
  datasheets: 0,
  customers: 0,
  openAccessRequests: 0,
  openWhistleblowerCases: 0,
};

/* Empties every collection getCounts reads, so each test starts clean. */
beforeEach(async () => {
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AreaModel.deleteMany({}),
    DatasheetModel.deleteMany({}),
    AccessRequestModel.deleteMany({}),
    WhistleblowerCaseModel.deleteMany({}),
    // Better Auth owns `users`; the Mongoose model is read-only, so tests
    // seed and clear it with the raw driver, as Better Auth itself would.
    getDb().collection("users").deleteMany({}),
  ]);
});

/* Seeds 2 main + 3 sub categories and returns a main category id. */
async function seedCategories(): Promise<mongoose.Types.ObjectId> {
  const [spot, track] = await CategoryModel.create([
    { name: "Spot Lights", slug: "spot-lights", parent: null },
    { name: "Magnetic Track", slug: "magnetic-track", parent: null },
  ]);
  if (!spot || !track) throw new Error("seed failed");
  await CategoryModel.create([
    { name: "Recessed", slug: "recessed", parent: spot._id },
    { name: "5mm", slug: "5mm", parent: track._id },
    { name: "10mm", slug: "10mm", parent: track._id, order: 1 },
  ]);
  return spot._id;
}

/* Seeds 3 published and 2 draft products under `mainCategory`. */
async function seedProducts(mainCategory: mongoose.Types.ObjectId) {
  const statuses: ProductStatus[] = [
    "published",
    "published",
    "published",
    "draft",
    "draft",
  ];
  await ProductModel.create(
    statuses.map((status, index) => ({
      name: `Product ${index}`,
      slug: `product-${index}`,
      mainCategory,
      status,
    })),
  );
}

/* Seeds users with the role strings Better Auth's admin plugin can store. */
async function seedUsers() {
  const now = new Date();
  const user = (email: string, role: string | null, banned = false) => ({
    name: email,
    email,
    emailVerified: false,
    role,
    banned,
    createdAt: now,
    updatedAt: now,
  });
  await getDb()
    .collection("users")
    .insertMany([
      user("admin@example.com", "admin"),
      user("a@example.com", "customer"),
      user("b@example.com", "customer"),
      // Banned customers are still customer accounts.
      user("c@example.com", "customer", true),
      // A comma-joined list holding "customer" counts, like hasRole() does.
      user("d@example.com", "admin,customer"),
      user("e@example.com", " customer "),
      // Look-alikes and missing roles do not.
      user("f@example.com", "customers"),
      user("g@example.com", "notcustomer"),
      user("h@example.com", null),
    ]);
}

/* Seeds 2 pending, 1 approved and 1 rejected access request. */
async function seedAccessRequests() {
  await AccessRequestModel.create(
    (["pending", "pending", "approved", "rejected"] as const).map(
      (status, index) => ({
        name: `Visitor ${index}`,
        email: `visitor${index}@example.com`,
        source: "form" as const,
        status,
      }),
    ),
  );
}

/* Seeds cases: 2 received, 1 under review, 2 closed. */
async function seedWhistleblowerCases() {
  const statuses: CaseStatus[] = [
    "received",
    "received",
    "under_review",
    "closed",
    "closed",
  ];
  await WhistleblowerCaseModel.create(
    statuses.map((status, index) => ({
      caseNumber: `WB-${index}`,
      passwordHash: "hash",
      body: {
        ciphertext: "secret-report",
        iv: "iv",
        tag: "tag",
        keyVersion: 1,
      },
      status,
    })),
  );
}

/* Every non-object value in a nested object, depth first. */
function leafValues(value: unknown): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  return Object.values(value).flatMap(leafValues);
}

describe("getCounts", () => {
  it("returns all zeros for an empty database", async () => {
    expect(await getCounts(admin)).toEqual(ZERO_COUNTS);
  });

  it("counts every dashboard figure from a known seed", async () => {
    const mainCategory = await seedCategories();
    await seedProducts(mainCategory);
    await AreaModel.create([
      { name: "Retail", slug: "retail" },
      { name: "Office", slug: "office", order: 1 },
    ]);
    const uploadedBy = new ObjectId();
    await DatasheetModel.create(
      [1, 2, 3].map((n) => ({
        storageKey: `datasheets/${n}.xlsx`,
        fileName: `${n}.xlsx`,
        size: 100,
        // Without the assertion the literal widens to string inside map().
        mimeType: XLSX_MIME_TYPE as typeof XLSX_MIME_TYPE,
        uploadedBy,
      })),
    );
    await seedUsers();
    await seedAccessRequests();
    await seedWhistleblowerCases();

    expect(await getCounts(admin)).toEqual({
      products: { total: 5, published: 3, draft: 2 },
      categories: { main: 2, sub: 3 },
      areas: 2,
      datasheets: 3,
      // a, b, c (banned), d ("admin,customer"), e (" customer ").
      customers: 5,
      openAccessRequests: 2,
      openWhistleblowerCases: 3,
    } satisfies DashboardCounts);
  });

  it("does not count look-alike or missing roles as customers", async () => {
    const now = new Date();
    await getDb()
      .collection("users")
      .insertMany(
        ["customers", "notcustomer", "admin", null].map((role, index) => ({
          name: `u${index}`,
          email: `u${index}@example.com`,
          emailVerified: false,
          role,
          createdAt: now,
          updatedAt: now,
        })),
      );

    expect((await getCounts(admin)).customers).toBe(0);
  });

  it("returns only numbers, never document content", async () => {
    await seedWhistleblowerCases();
    const counts = await getCounts(admin);

    expect(leafValues(counts).every(Number.isInteger)).toBe(true);
    expect(JSON.stringify(counts)).not.toContain("secret-report");
  });
});
