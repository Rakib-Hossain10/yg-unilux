// Tests for src/lib/audit.ts on an in-memory MongoDB: a valid admin write is
// recorded, and bad input (unknown or system action, oversize or nested meta,
// bad actor id, target that does not match the action) is rejected unwritten.

import { beforeEach, describe, expect, it } from "vitest";

import { mongoose } from "@/lib/db";
import { AuditLogModel, MAX_AUDIT_META_BYTES } from "@/models/audit-log";
import { setupMemoryDb } from "../../test/helpers/memory-db";

import {
  ADMIN_AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  AuditInputError,
  recordAudit,
  type AuditInput,
} from "./audit";

setupMemoryDb("yg_audit_test");

const ACTOR = new mongoose.Types.ObjectId().toHexString();
const PRODUCT = new mongoose.Types.ObjectId().toHexString();

/* A valid input; tests override one field at a time. */
function input(overrides: Record<string, unknown> = {}): AuditInput {
  return {
    actorId: ACTOR,
    action: "product.update",
    target: { type: "product", id: PRODUCT },
    meta: { fields: ["name", "slug"], variantCount: 2 },
    ...overrides,
  } as AuditInput;
}

/* Calls recordAudit with input that the types would refuse. */
function recordUntyped(value: unknown) {
  return recordAudit(value as AuditInput);
}

beforeEach(async () => {
  await AuditLogModel.deleteMany({});
});

describe("recordAudit", () => {
  it("writes one entry with the actor, action, target and meta", async () => {
    const { id } = await recordAudit(input());

    const entries = await AuditLogModel.find({}).lean();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry?._id.toHexString()).toBe(id);
    expect(entry?.actor?.toHexString()).toBe(ACTOR);
    expect(entry).toMatchObject({
      action: "product.update",
      target: { type: "product", id: PRODUCT },
      meta: { fields: ["name", "slug"], variantCount: 2 },
    });
    expect(entry?.createdAt).toBeInstanceOf(Date);
  });

  it("accepts an entry without meta, and a settings key as the target id", async () => {
    await recordAudit(
      input({
        action: "settings.columns.update",
        target: { type: "settings", id: "settings.columnVisibility" },
        meta: undefined,
      }),
    );
    const entry = await AuditLogModel.findOne({}).lean();
    expect(entry).toMatchObject({ action: "settings.columns.update" });
    expect(entry?.meta).toBeUndefined();
  });

  it("accepts an import batch addressed by its staged file's uuid, with count/id meta", async () => {
    const uuid = "3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b";
    // The plan's meta at batch size 20: counts plus 20 product ids.
    const productIds = Array.from({ length: 20 }, () =>
      new mongoose.Types.ObjectId().toHexString(),
    );
    await recordAudit(
      input({
        action: "import.commit",
        target: { type: "import", id: uuid },
        meta: {
          batch: 0,
          created: 12,
          updated: 6,
          unchanged: 2,
          blocked: 0,
          imagesAdded: 14,
          variantsRemoved: 0,
          productIds,
        },
      }),
    );
    const entry = await AuditLogModel.findOne({}).lean();
    expect(entry).toMatchObject({
      action: "import.commit",
      target: { type: "import", id: uuid },
    });
  });

  it("accepts meta of exactly 4096 bytes and rejects 4097", async () => {
    /*
     * {"ids":[...]} with 39 strings of 100 chars and a last one of `last`
     * chars serialises to 10 + 39 * 103 + (last + 2) = 4029 + last bytes.
     */
    const metaOf = (last: number) => ({
      ids: [
        ...Array.from({ length: 39 }, () => "i".repeat(100)),
        "i".repeat(last),
      ],
    });
    expect(Buffer.byteLength(JSON.stringify(metaOf(67)))).toBe(
      MAX_AUDIT_META_BYTES,
    );

    await expect(recordAudit(input({ meta: metaOf(67) }))).resolves.toEqual({
      id: expect.any(String),
    });
    await expect(
      recordAudit(input({ meta: metaOf(68) })),
    ).rejects.toBeInstanceOf(AuditInputError);
    expect(await AuditLogModel.countDocuments({})).toBe(1);
  });

  describe("rejects and writes nothing", () => {
    it.each<[string, Record<string, unknown>]>([
      ["an unknown action", { action: "product.explode" }],
      ["a free-form action string", { action: "Product.Update" }],
      // System entries are written by Phase 1 code directly, never by admin services.
      ["a system action (auth)", { action: "auth.rate_limited" }],
      ["a system action (CLI)", { action: "admin.cli_create" }],
      ["an actor id that is not an ObjectId", { actorId: "not-an-id" }],
      // 12 characters: Mongoose would cast this to an ObjectId if it got through.
      ["a 12-character actor id", { actorId: "aaaaaaaaaaaa" }],
      ["an empty actor id", { actorId: "" }],
      ["a missing actor id", { actorId: undefined }],
      ["a missing target", { target: undefined }],
      ["an unknown target type", { target: { type: "user", id: PRODUCT } }],
      ["an empty target id", { target: { type: "product", id: " " } }],
      [
        "a target that does not match the action",
        { target: { type: "category", id: PRODUCT } },
      ],
      ["nested objects in meta", { meta: { before: { name: "Arc" } } }],
      ["a Date in meta", { meta: { at: new Date() } }],
      ["a non-finite number in meta", { meta: { count: Number.NaN } }],
      ["an unknown top-level field", { ip: "203.0.113.9" }],
      [
        "a record target id that is not an ObjectId",
        { target: { type: "product", id: "arc-ar-013a" } },
      ],
      [
        "a settings target id that is a value, not a key",
        {
          action: "settings.whatsapp.update",
          target: { type: "settings", id: "+85291234567" },
        },
      ],
      [
        "an import target addressed by an ObjectId",
        { action: "import.commit", target: { type: "import", id: PRODUCT } },
      ],
      [
        "an import target that is the whole staged key",
        {
          action: "import.commit",
          target: {
            type: "import",
            id: "imports/3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b.xlsx",
          },
        },
      ],
      [
        "an import target with an upper-case uuid",
        {
          action: "import.commit",
          target: {
            type: "import",
            id: "3F1C2A4E-9B7D-4C1E-8A2B-5D6E7F809A1B",
          },
        },
      ],
      ["an import action on a product target", { action: "import.commit" }],
      [
        "a product action on an import target",
        {
          target: {
            type: "import",
            id: "3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b",
          },
        },
      ],
      ["a meta key that is a Mongo operator", { meta: { $where: 1 } }],
      ["a meta key with a dot", { meta: { "a.b": 1 } }],
      [
        "a meta string over 200 characters",
        { meta: { note: "x".repeat(201) } },
      ],
      [
        "a meta list over 200 items",
        { meta: { ids: Array.from({ length: 201 }, () => 1) } },
      ],
      [
        "more than 50 meta keys",
        {
          meta: Object.fromEntries(
            Array.from({ length: 51 }, (_, i) => [`k${i}`, 1]),
          ),
        },
      ],
    ])("%s", async (_label, overrides) => {
      await expect(recordUntyped(input(overrides))).rejects.toBeInstanceOf(
        AuditInputError,
      );
      expect(await AuditLogModel.countDocuments({})).toBe(0);
    });

    it("meta larger than the limit, without echoing its content", async () => {
      // 30 values of 190 chars: each under the 200-char per-value cap and the
      // key count under 50, so only the total (over 4096 bytes) is at fault.
      const meta = Object.fromEntries(
        Array.from({ length: 30 }, (_, i) => [`field${i}`, "s".repeat(190)]),
      );
      expect(Buffer.byteLength(JSON.stringify(meta))).toBeGreaterThan(
        MAX_AUDIT_META_BYTES,
      );

      const error = await recordAudit(input({ meta })).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AuditInputError);
      expect((error as AuditInputError).paths).toContain("meta");
      expect((error as Error).message).not.toContain("sss");
      expect(await AuditLogModel.countDocuments({})).toBe(0);
    });
  });
});

describe("audit vocabulary", () => {
  it("has the import action and target type (Phase 3)", () => {
    expect(ADMIN_AUDIT_ACTIONS).toContain("import.commit");
    expect(AUDIT_TARGET_TYPES).toContain("import");
  });

  it("every admin action starts with a target type, so each one can be recorded", () => {
    const types: readonly string[] = AUDIT_TARGET_TYPES;
    for (const action of ADMIN_AUDIT_ACTIONS) {
      expect(types).toContain(action.split(".")[0]);
    }
  });
});
