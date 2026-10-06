// Validation tests for the smaller models: datasheets (size and MIME limits),
// access requests, download logs, site content, audit log, leaders, login
// attempts, plus the category slug-per-parent rule on an in-memory MongoDB.

import { beforeAll, describe, expect, it } from "vitest";

import type { Model } from "mongoose";

import { mongoose } from "@/lib/db";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import { AccessRequestModel } from "./access-request";
import { AuditLogModel, MAX_AUDIT_META_BYTES } from "./audit-log";
import { CategoryModel } from "./category";
import { DatasheetModel } from "./datasheet";
import { DownloadLogModel } from "./download-log";
import { LeaderModel } from "./leader";
import { LoginAttemptModel } from "./login-attempt";
import { SiteContentModel } from "./site-content";

const id = () => new mongoose.Types.ObjectId();

/** The validation error paths for an input, or [] if it is valid. */
async function invalidPaths<T>(
  model: Model<T>,
  input: Record<string, unknown>,
): Promise<string[]> {
  try {
    await new model(input).validate();
    return [];
  } catch (error) {
    if (error instanceof mongoose.Error.ValidationError) {
      return Object.keys(error.errors).sort();
    }
    throw error;
  }
}

describe("datasheets", () => {
  const XLSX =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const TEN_MB = 10 * 1024 * 1024;
  const sheet = (overrides: Record<string, unknown> = {}) => ({
    storageKey: "datasheets/arc.xlsx",
    fileName: "Arc.xlsx",
    size: 2048,
    mimeType: XLSX,
    uploadedBy: id(),
    ...overrides,
  });

  it("accepts an .xlsx up to exactly 10 MB", async () => {
    expect(await invalidPaths(DatasheetModel, sheet({ size: TEN_MB }))).toEqual(
      [],
    );
  });

  it.each([
    ["empty", 0],
    ["one byte over 10 MB", TEN_MB + 1],
    ["fractional", 10.5],
  ])("rejects a %s size", async (_label, size) => {
    expect(await invalidPaths(DatasheetModel, sheet({ size }))).toEqual([
      "size",
    ]);
  });

  it.each(["application/vnd.ms-excel", "application/zip", "text/csv"])(
    "rejects the MIME type %s",
    async (mimeType) => {
      expect(await invalidPaths(DatasheetModel, sheet({ mimeType }))).toEqual([
        "mimeType",
      ]);
    },
  );

  it("requires the storage key, file name, size, type and uploader", async () => {
    expect(await invalidPaths(DatasheetModel, {})).toEqual([
      "fileName",
      "mimeType",
      "size",
      "storageKey",
      "uploadedBy",
    ]);
  });
});

describe("access requests", () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    name: "Jane",
    email: "  Jane@Example.COM ",
    source: "form",
    ...overrides,
  });

  it("starts pending and stores the email lowercased", () => {
    const doc = new AccessRequestModel(request());
    expect(doc.status).toBe("pending");
    expect(doc.email).toBe("jane@example.com");
  });

  it("only allows the form and whatsapp sources", async () => {
    expect(
      await invalidPaths(AccessRequestModel, request({ source: "email" })),
    ).toEqual(["source"]);
    expect(
      await invalidPaths(AccessRequestModel, request({ source: undefined })),
    ).toEqual(["source"]);
  });

  it("only allows the pending, approved and rejected statuses", async () => {
    expect(
      await invalidPaths(AccessRequestModel, request({ status: "expired" })),
    ).toEqual(["status"]);
  });

  it("rejects an email without @ and domain", async () => {
    expect(
      await invalidPaths(AccessRequestModel, request({ email: "jane" })),
    ).toEqual(["email"]);
  });
});

describe("download logs", () => {
  it("requires user, product and datasheet and stamps downloadedAt", async () => {
    expect(await invalidPaths(DownloadLogModel, {})).toEqual([
      "datasheet",
      "product",
      "user",
    ]);
    const log = new DownloadLogModel({
      user: id(),
      product: id(),
      datasheet: id(),
    });
    expect(log.downloadedAt).toBeInstanceOf(Date);
  });

  it("has no createdAt/updatedAt timestamps", () => {
    expect(DownloadLogModel.schema.path("updatedAt")).toBeUndefined();
    expect(DownloadLogModel.schema.path("createdAt")).toBeUndefined();
  });
});

describe("site content", () => {
  it.each(["home.quote", "settings.columnVisibility", "settings.companyEmail"])(
    "accepts the key %s",
    async (key) => {
      expect(await invalidPaths(SiteContentModel, { key, value: "x" })).toEqual(
        [],
      );
    },
  );

  it.each(["home", "Home.quote", "settings..x", "settings.column-visibility"])(
    "rejects the key %s",
    async (key) => {
      expect(await invalidPaths(SiteContentModel, { key, value: "x" })).toEqual(
        ["key"],
      );
    },
  );

  it("requires a value", async () => {
    expect(await invalidPaths(SiteContentModel, { key: "home.quote" })).toEqual(
      ["value"],
    );
  });
});

describe("audit log", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    actor: id(),
    action: "product.update",
    target: { type: "product", id: id().toHexString() },
    ...overrides,
  });

  it("accepts a small entry and has createdAt but no updatedAt", async () => {
    expect(
      await invalidPaths(AuditLogModel, entry({ meta: { fields: ["name"] } })),
    ).toEqual([]);
    expect(AuditLogModel.schema.path("createdAt")).toBeDefined();
    expect(AuditLogModel.schema.path("updatedAt")).toBeUndefined();
  });

  it("rejects meta larger than the limit", async () => {
    const meta = { note: "x".repeat(MAX_AUDIT_META_BYTES) };
    expect(await invalidPaths(AuditLogModel, entry({ meta }))).toEqual([
      "meta",
    ]);
  });

  it("requires the actor and action", async () => {
    expect(await invalidPaths(AuditLogModel, {})).toEqual(["action", "actor"]);
  });

  it("lets anonymous auth.* security events go without an actor, and only those", async () => {
    const limited = {
      action: "auth.rate_limited",
      meta: { namespace: "email-ip-login", reason: "hard_limit" },
    };
    expect(await invalidPaths(AuditLogModel, limited)).toEqual([]);
    expect(
      await invalidPaths(AuditLogModel, { action: "product.update" }),
    ).toEqual(["actor"]);
    // Not in the vocabulary, so the action fails too; and still no actor.
    expect(
      await invalidPaths(AuditLogModel, { action: "xauth.rate_limited" }),
    ).toEqual(["action", "actor"]);
  });

  it("rejects an action outside the shared vocabulary", async () => {
    expect(
      await invalidPaths(AuditLogModel, entry({ action: "product.explode" })),
    ).toEqual(["action"]);
    expect(
      await invalidPaths(AuditLogModel, entry({ action: "admin.cli_create" })),
    ).toEqual([]);
  });
});

describe("leaders", () => {
  it("requires name and title, and a public id when a photo is given", async () => {
    expect(
      await invalidPaths(LeaderModel, { photo: { alt: "Portrait" } }),
    ).toEqual(["name", "photo.publicId", "title"]);
  });
});

describe("login attempts", () => {
  it("requires key and expiresAt and starts the count at 0", async () => {
    expect(await invalidPaths(LoginAttemptModel, {})).toEqual([
      "expiresAt",
      "key",
    ]);
    expect(new LoginAttemptModel({ key: "email:a@b.co" }).count).toBe(0);
  });

  it("rejects a negative or fractional count", async () => {
    const base = { key: "email:a@b.co", expiresAt: new Date() };
    expect(
      await invalidPaths(LoginAttemptModel, { ...base, count: -1 }),
    ).toEqual(["count"]);
    expect(
      await invalidPaths(LoginAttemptModel, { ...base, count: 1.5 }),
    ).toEqual(["count"]);
  });
});

describe("stored documents", () => {
  setupMemoryDb("yg_validation_test");

  beforeAll(async () => {
    await CategoryModel.createIndexes();
    await SiteContentModel.createIndexes();
  });

  it("keeps category slugs unique per parent, including among main categories", async () => {
    const spot = await CategoryModel.create({
      name: "Spot Lights",
      slug: "spot-lights",
    });
    const recessedLights = await CategoryModel.create({
      name: "Recessed Lights",
      slug: "recessed-lights",
    });
    expect(spot.parent).toBeNull();

    // "recessed" may exist under two different parents...
    await CategoryModel.create({
      name: "Recessed",
      slug: "recessed",
      parent: spot._id,
    });
    await expect(
      CategoryModel.create({
        name: "Recessed",
        slug: "recessed",
        parent: recessedLights._id,
      }),
    ).resolves.toBeDefined();

    // ...but not twice under one parent, nor as two main categories.
    await expect(
      CategoryModel.create({
        name: "Recessed 2",
        slug: "recessed",
        parent: spot._id,
      }),
    ).rejects.toMatchObject({ code: 11000 });
    await expect(
      CategoryModel.create({ name: "Spot", slug: "spot-lights" }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("stores an empty object as a site content value", async () => {
    await SiteContentModel.create({
      key: "settings.columnVisibility",
      value: {},
    });
    const stored = await SiteContentModel.findOne({
      key: "settings.columnVisibility",
    }).lean();
    expect(stored?.value).toEqual({});
  });
});
