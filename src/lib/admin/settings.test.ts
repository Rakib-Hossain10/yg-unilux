// Tests for the settings services (src/lib/admin/settings.ts) on an
// in-memory MongoDB: defaults, validation, no-op writes, tags, the filter
// cleanup for newly restricted columns, and audit meta without values.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";
import { DEFAULT_COLUMN_VISIBILITY } from "@/lib/schemas/settings";
import { ProductModel, SiteContentModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { setupMemoryDb } from "../../../test/helpers/memory-db";

import {
  getAdminSettings,
  getColumnVisibility,
  saveColumnVisibility,
  saveCompanyEmail,
  saveWhatsappNumber,
} from "./settings";
import { AUDIT_FAILED_MESSAGE, type ServiceResult } from "./write-result";

setupMemoryDb("yg_admin_settings_test");

const { ObjectId } = mongoose.Types;
const ADMIN = new ObjectId().toHexString();

beforeEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    SiteContentModel.deleteMany({}),
    ProductModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
});

function expectOk<T>(result: ServiceResult<T>): T {
  if (!result.ok)
    throw new Error(`expected ok: ${JSON.stringify(result.errors)}`);
  return result.data;
}

const withColumns = (patch: Record<string, "public" | "restricted">) => ({
  ...DEFAULT_COLUMN_VISIBILITY,
  ...patch,
});

describe("reads", () => {
  it("returns defaults when nothing was saved", async () => {
    expect(await getColumnVisibility()).toEqual(DEFAULT_COLUMN_VISIBILITY);
    expect(await getAdminSettings()).toEqual({
      columnVisibility: DEFAULT_COLUMN_VISIBILITY,
      whatsappNumber: null,
      companyEmail: null,
    });
  });

  it("fails closed on a damaged stored document", async () => {
    await SiteContentModel.create({
      key: "settings.columnVisibility",
      value: { lens: "public", driver: 5 },
    });
    const v = await getColumnVisibility();
    expect(v.lens).toBe("public");
    expect(v.driver).toBe("restricted");
    expect(v.cct).toBe("restricted");
  });
});

describe("saveColumnVisibility", () => {
  it("rejects bad input and writes nothing", async () => {
    const result = await saveColumnVisibility(ADMIN, { lens: "public" });
    expect(result.ok).toBe(false);
    expect(result.tags).toEqual([]);
    expect(await SiteContentModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("throws for a non-id actor (visitor or forged)", async () => {
    await expect(
      saveColumnVisibility("", DEFAULT_COLUMN_VISIBILITY),
    ).rejects.toThrow(TypeError);
    await expect(
      saveColumnVisibility("customer", DEFAULT_COLUMN_VISIBILITY),
    ).rejects.toThrow(TypeError);
  });

  it("saves, returns settings:columns + products and audits keys only", async () => {
    const result = await saveColumnVisibility(
      ADMIN,
      withColumns({ driver: "public", lens: "restricted" }),
    );
    const data = expectOk(result);
    expect(result.tags).toEqual(["settings:columns", "products"]);
    expect(data.newlyRestricted).toEqual(["lens"]);
    expect(data.newlyPublic).toEqual(["driver"]);
    expect((await getColumnVisibility()).driver).toBe("public");

    const [entry, ...rest] = await AuditLogModel.find({}).lean();
    expect(rest).toHaveLength(0);
    expect(entry?.action).toBe("settings.columns.update");
    expect(entry?.target).toEqual({
      type: "settings",
      id: "settings.columnVisibility",
    });
    expect(entry?.meta).toEqual({
      restricted: ["lens"],
      madePublic: ["driver"],
      restrictedCount: 5,
      cleanupFailed: false,
    });
  });

  it("is a no-op when nothing changes (after the first save)", async () => {
    expectOk(await saveColumnVisibility(ADMIN, DEFAULT_COLUMN_VISIBILITY));
    const again = await saveColumnVisibility(ADMIN, DEFAULT_COLUMN_VISIBILITY);
    expect(again.ok && again.tags).toEqual([]);
    expect(await AuditLogModel.countDocuments()).toBe(1);
  });

  it("clears the filter of a newly restricted column on all products, keeps others", async () => {
    const mainCategory = new ObjectId();
    await ProductModel.create([
      {
        name: "A",
        slug: "a-1",
        mainCategory,
        filters: { cctK: [3000, 4000], cri: [80], wattage: [10] },
      },
      {
        name: "B",
        slug: "b-1",
        mainCategory,
        filters: { cctK: [2700], ugr: [19] },
      },
      { name: "C", slug: "c-1", mainCategory },
    ]);

    expectOk(
      await saveColumnVisibility(ADMIN, withColumns({ cct: "restricted" })),
    );

    const [a, b, c] = await Promise.all(
      ["a-1", "b-1", "c-1"].map((slug) =>
        ProductModel.findOne({ slug }).lean(),
      ),
    );
    expect(a?.filters?.cctK).toBeUndefined();
    expect(a?.filters?.cri).toEqual([80]);
    expect(a?.filters?.wattage).toEqual([10]);
    expect(b?.filters?.cctK).toBeUndefined();
    expect(b?.filters?.ugr).toEqual([19]);
    expect(c?.filters?.cctK).toBeUndefined();
  });

  it("does not touch filters when a column becomes public or has no filter", async () => {
    await ProductModel.create({
      name: "A",
      slug: "a-1",
      mainCategory: new ObjectId(),
      filters: { cctK: [3000] },
    });
    // driver -> public, lens -> restricted: neither has a filter.
    expectOk(
      await saveColumnVisibility(
        ADMIN,
        withColumns({ driver: "public", lens: "restricted" }),
      ),
    );
    expect((await ProductModel.findOne({}).lean())?.filters?.cctK).toEqual([
      3000,
    ]);
  });

  it("re-runs the cleanup on an otherwise unchanged save and returns the tags", async () => {
    expectOk(
      await saveColumnVisibility(ADMIN, withColumns({ cct: "restricted" })),
    );
    await ProductModel.create({
      name: "A",
      slug: "a-1",
      mainCategory: new ObjectId(),
      filters: { cctK: [3000], cri: [80] },
    });
    const again = await saveColumnVisibility(
      ADMIN,
      withColumns({ cct: "restricted" }),
    );
    expect(again.ok && again.tags).toEqual(["settings:columns", "products"]);
    const product = await ProductModel.findOne({}).lean();
    expect(product?.filters?.cctK).toBeUndefined();
    expect(product?.filters?.cri).toEqual([80]);
    expect(await AuditLogModel.countDocuments()).toBe(1);
  });

  it("repairs products on retry after a failed cleanup, and keeps updatedAt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await ProductModel.create({
      name: "A",
      slug: "a-1",
      mainCategory: new ObjectId(),
      filters: { cctK: [3000] },
    });
    const untouched = await ProductModel.create({
      name: "B",
      slug: "b-1",
      mainCategory: new ObjectId(),
    });
    const before = (await ProductModel.findById(untouched._id).lean())
      ?.updatedAt;
    vi.spyOn(ProductModel, "updateMany").mockRejectedValueOnce(
      new Error("boom"),
    );
    const failed = await saveColumnVisibility(
      ADMIN,
      withColumns({ cct: "restricted" }),
    );
    expect(failed.ok).toBe(false);
    expect(
      (await ProductModel.findOne({ slug: "a-1" }).lean())?.filters?.cctK,
    ).toEqual([3000]);
    // The change is saved, so it is audited with the failure flagged.
    const entry = await AuditLogModel.findOne({}).lean();
    expect(entry?.meta).toMatchObject({ cleanupFailed: true });

    const retry = await saveColumnVisibility(
      ADMIN,
      withColumns({ cct: "restricted" }),
    );
    expect(retry.ok).toBe(true);
    expect(
      (await ProductModel.findOne({ slug: "a-1" }).lean())?.filters?.cctK,
    ).toBeUndefined();
    expect(
      (await ProductModel.findById(untouched._id).lean())?.updatedAt,
    ).toEqual(before);
  });

  it("still returns the tags when the cleanup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(ProductModel, "updateMany").mockRejectedValueOnce(
      new Error("boom"),
    );
    const result = await saveColumnVisibility(
      ADMIN,
      withColumns({ cct: "restricted" }),
    );
    expect(result.ok).toBe(false);
    expect(result.tags).toEqual(["settings:columns", "products"]);
    expect((await getColumnVisibility()).cct).toBe("restricted");
  });

  it("returns the tags with an audit error when the audit write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(AuditLogModel, "create").mockRejectedValueOnce(new Error("down"));
    const result = await saveColumnVisibility(
      ADMIN,
      withColumns({ driver: "public" }),
    );
    expect(!result.ok && result.errors.formErrors).toEqual([
      AUDIT_FAILED_MESSAGE,
    ]);
    expect(result.tags).toEqual(["settings:columns", "products"]);
  });
});

describe("saveWhatsappNumber", () => {
  it("normalises, stores digits, audits without the number", async () => {
    const result = await saveWhatsappNumber(ADMIN, "+852 9123-4567");
    expect(expectOk(result)).toEqual({ whatsappNumber: "85291234567" });
    expect(result.tags).toEqual([]);
    expect((await getAdminSettings()).whatsappNumber).toBe("85291234567");

    const entry = await AuditLogModel.findOne({}).lean();
    expect(entry?.action).toBe("settings.whatsapp.update");
    expect(JSON.stringify(entry)).not.toMatch(/9123|85291234567/);
    expect(entry?.meta).toEqual({ isSet: true });
  });

  it("clears with an empty string and is a no-op when unchanged", async () => {
    expectOk(await saveWhatsappNumber(ADMIN, "85291234567"));
    expectOk(await saveWhatsappNumber(ADMIN, ""));
    expect((await getAdminSettings()).whatsappNumber).toBeNull();
    const again = await saveWhatsappNumber(ADMIN, "");
    expect(again.ok && again.tags).toEqual([]);
    expect(await AuditLogModel.countDocuments()).toBe(2);
  });

  it("clearing with an empty string works on a stored number and when none is stored", async () => {
    expect(expectOk(await saveWhatsappNumber(ADMIN, ""))).toEqual({
      whatsappNumber: null,
    });
    expect(await AuditLogModel.countDocuments()).toBe(0);
    expectOk(await saveWhatsappNumber(ADMIN, "85291234567"));
    expectOk(await saveWhatsappNumber(ADMIN, ""));
    expect(await SiteContentModel.countDocuments()).toBe(0);
    expect((await getAdminSettings()).whatsappNumber).toBeNull();
  });

  it("rejects junk and bad actors", async () => {
    expect((await saveWhatsappNumber(ADMIN, "call me")).ok).toBe(false);
    expect((await saveWhatsappNumber(ADMIN, 123)).ok).toBe(false);
    await expect(saveWhatsappNumber("x", "85291234567")).rejects.toThrow(
      TypeError,
    );
    expect(await SiteContentModel.countDocuments()).toBe(0);
  });
});

describe("saveCompanyEmail", () => {
  it("lowercases, stores and audits without the address", async () => {
    const result = await saveCompanyEmail(ADMIN, " Sales@YG-Unilux.com ");
    expect(expectOk(result)).toEqual({ companyEmail: "sales@yg-unilux.com" });
    expect((await getAdminSettings()).companyEmail).toBe("sales@yg-unilux.com");

    const entry = await AuditLogModel.findOne({}).lean();
    expect(entry?.action).toBe("settings.email.update");
    expect(JSON.stringify(entry)).not.toMatch(/sales|yg-unilux/i);
    expect(entry?.meta).toEqual({ isSet: true });
  });

  it("clearing with an empty string deletes the stored value", async () => {
    expectOk(await saveCompanyEmail(ADMIN, "a@b.co"));
    expectOk(await saveCompanyEmail(ADMIN, ""));
    expect(await SiteContentModel.countDocuments()).toBe(0);
    expect((await getAdminSettings()).companyEmail).toBeNull();
  });

  it("rejects an invalid address, clears with empty, no-op on repeat", async () => {
    expect((await saveCompanyEmail(ADMIN, "nope")).ok).toBe(false);
    expectOk(await saveCompanyEmail(ADMIN, "a@b.co"));
    expectOk(await saveCompanyEmail(ADMIN, ""));
    expect((await getAdminSettings()).companyEmail).toBeNull();
    expect((await saveCompanyEmail(ADMIN, "")).ok).toBe(true);
    expect(await AuditLogModel.countDocuments()).toBe(2);
    await expect(saveCompanyEmail("", "a@b.co")).rejects.toThrow(TypeError);
  });
});
