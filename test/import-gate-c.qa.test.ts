// Phase 3 QA gate C (exit): the bulk import end to end through the REAL
// Server Actions and the REAL services (no service mocks), with only the
// session, R2 and Cloudinary faked and MongoDB in memory. Covers what the
// per-module tests cannot: the shaped action answers never carry restricted
// spec values or picture hashes outside the admin's own diff, the restricted
// diff rows are the ones the page marks "Restricted", the audit actor is the
// session's, logs stay value-free, re-import is a no-op through the actions,
// and hostile inputs (operator objects, foreign keys) reach no storage call.
// `it.fails` = a finding of this gate (see the gate C report).

import { createHash, randomUUID } from "node:crypto";

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
  commitImportBatchAction,
  finishImportAction,
  presignImportUploadAction,
  previewImportAction,
} from "@/app/admin/import/actions";
import {
  batchesToSend,
  isRestrictedChange,
  type ImportPreviewView,
  type PlanView,
} from "@/components/admin/import/import-view";
import { getColumnVisibility } from "@/lib/admin/settings";
import { buildPublicId } from "@/lib/cloudinary-ids";
import * as cloudinary from "@/lib/cloudinary";
import { MAX_IMPORT_PLAN_ENTRIES } from "@/lib/constants";
import { mongoose } from "@/lib/db";
import { buildImportTemplate } from "@/lib/import/template";
import * as storage from "@/lib/storage";
import { AreaModel, CategoryModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";

import {
  fillTemplate,
  goldenTemplateRows,
  TEMPLATE_INPUT,
  type TemplateRow,
} from "./fixtures/import/template-fixture";
import { setupMemoryDb } from "./helpers/memory-db";

const getSession = vi.hoisted(() => vi.fn());
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));
vi.mock("next/cache", () => nextCache);
vi.mock("@/lib/storage", () => {
  class StorageConditionError extends Error {
    override name = "StorageConditionError";
  }
  return {
    getImportBytes: vi.fn(),
    deleteImportUpload: vi.fn(),
    presignImportUpload: vi.fn(),
    presignPut: vi.fn(),
    deleteObject: vi.fn(),
    StorageConditionError,
  };
});
vi.mock("@/lib/cloudinary", () => ({
  uploadImageBuffer: vi.fn(),
  destroyImage: vi.fn(),
}));

setupMemoryDb("yg_import_gate_c_qa");

const { ObjectId } = mongoose.Types;
const ADMIN_ID = new ObjectId().toHexString();
const KEY = `imports/${randomUUID()}.xlsx`;
const ETAG = '"etag-c"';

/* Distinctive values in every restricted column the template has. */
const RESTRICTED_FILL = {
  "Batch No.": "QXBATCH77",
  "Chip Type": "QXCHIP77",
  Holder: "QXHOLDER77",
  "Chip Efficiency": "QXEFF77",
  Driver: "QXDRIVER77",
};
const RESTRICTED_VALUES = Object.values(RESTRICTED_FILL);
/* A value in a cell that the reader warns about would show up in the
   warning detail; it must never reach a log or the audit trail. */
const WARNING_VALUE = "QXWARN77";

let defaultCategory: string;
let logged: string[] = [];

const sha256 = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

function signedInAdmin() {
  getSession.mockResolvedValue({
    session: { id: "s1" },
    user: {
      id: ADMIN_ID,
      email: "admin@example.com",
      role: "admin",
      banned: false,
      banExpires: null,
      mustChangePassword: false,
      accessExpiresAt: null,
    },
  });
}

function rowsWith(change: Partial<TemplateRow>) {
  return goldenTemplateRows().map((r) => ({
    row: { ...r.row, ...change } as TemplateRow,
    picture: r.picture,
  }));
}

async function stage(change: Partial<TemplateRow> = RESTRICTED_FILL) {
  const bytes = await fillTemplate(
    await buildImportTemplate(TEMPLATE_INPUT),
    rowsWith(change),
  );
  vi.mocked(storage.getImportBytes).mockResolvedValue({
    ok: true,
    bytes: new Uint8Array(bytes),
    etag: ETAG,
  });
}

async function preview(): Promise<PlanView> {
  const result = await previewImportAction({
    key: KEY,
    defaultCategoryId: defaultCategory,
  });
  if (!result.ok || result.data.kind !== "plan") {
    throw new Error(JSON.stringify(result));
  }
  return result.data;
}

function commitInput(plan: PlanView, batch: number) {
  return {
    key: KEY,
    defaultCategoryId: defaultCategory,
    etag: plan.etag,
    planHash: plan.planHash,
    entryHashes: plan.entries.map((e) => e.hash),
    batch,
    acknowledgeRemovals: false,
  };
}

/* Runs the browser's loop: every batch that writes something, then finish. */
async function commitAll(plan: PlanView) {
  const answers = [];
  for (const batch of batchesToSend(plan.entries)) {
    answers.push(await commitImportBatchAction(commitInput(plan, batch)));
  }
  answers.push(await finishImportAction({ key: KEY }));
  return answers;
}

beforeAll(async () => {
  await ProductModel.createIndexes();
});

beforeEach(async () => {
  vi.clearAllMocks();
  getSession.mockReset();
  signedInAdmin();
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    AreaModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  const [d, spot, rec] = await CategoryModel.create([
    { name: "Default", slug: "default", parent: null, order: 0 },
    { name: "Spot Lights", slug: "spot-lights", parent: null, order: 1 },
    {
      name: "Recessed Lights",
      slug: "recessed-lights",
      parent: null,
      order: 2,
    },
  ]);
  await CategoryModel.create([
    { name: "Recessed", slug: "recessed", parent: spot?._id, order: 0 },
    { name: "Spot", slug: "spot", parent: rec?._id, order: 0 },
  ]);
  defaultCategory = d!._id.toHexString();
  await AreaModel.create([
    { name: "Residential", slug: "residential", order: 0 },
    { name: "Retail", slug: "retail", order: 1 },
    { name: "Hospitality", slug: "hospitality", order: 2 },
  ]);
  vi.mocked(cloudinary.uploadImageBuffer).mockImplementation(
    async (productId, data) => ({
      ok: true as const,
      image: {
        publicId: buildPublicId("product", productId, randomUUID()),
        sourceSha256: sha256(data),
        bytes: data.byteLength,
        format: "png",
        width: 8,
        height: 8,
      },
    }),
  );
  vi.mocked(cloudinary.destroyImage).mockResolvedValue(true);
  vi.mocked(storage.deleteImportUpload).mockResolvedValue(undefined);

  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((a) =>
            a instanceof Error
              ? `${a.name} ${a.message} ${a.stack}`
              : String(a),
          )
          .join(" "),
      );
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------ */

describe("gate C: the whole flow through the real actions", () => {
  it("answers carry no restricted value, picture hash or merged record", async () => {
    await stage();
    const plan = await preview();
    expect(plan.summary.create).toBe(3);
    const answers = await commitAll(plan);
    for (const answer of answers) expect(answer).toMatchObject({ ok: true });

    const text = JSON.stringify([plan, answers]);
    for (const value of RESTRICTED_VALUES) expect(text).not.toContain(value);
    // The bytes' hashes (plan.images[].sha256) never reach the browser.
    const stored = await ProductModel.find({}).lean();
    const shas = stored.flatMap((p) =>
      (p.images ?? []).map((i) => i.sourceSha256 as string),
    );
    expect(shas.length).toBeGreaterThan(0);
    for (const sha of shas) expect(text).not.toContain(sha);
    // No merged record, spec map, picture refs or bytes (summary.imagesToAdd
    // is a count, so the per-entry ref list is checked via "sha256").
    for (const key of ['"target"', '"specs"', '"files"', '"sha256"']) {
      expect(text).not.toContain(key);
    }
    // The values ARE in the database (restricted = stripped on read, not lost).
    expect(JSON.stringify(stored)).toContain("QXDRIVER77");
  });

  it("audits as the session's admin, counts and ids only; logs stay value-free", async () => {
    await stage({ ...RESTRICTED_FILL, Wattage: WARNING_VALUE });
    const plan = await preview();
    // The odd wattage is reported to the admin (screen only).
    expect(JSON.stringify(plan)).toContain(WARNING_VALUE);
    await commitAll(plan);

    const audit = await AuditLogModel.find({}).lean();
    expect(audit.length).toBeGreaterThan(0);
    for (const entry of audit) {
      expect(entry.actor?.toString()).toBe(ADMIN_ID);
      expect(entry.action).toBe("import.commit");
      expect(entry.target).toMatchObject({
        type: "import",
        id: KEY.slice(8, -5),
      });
      expect(Object.keys((entry.meta ?? {}) as object).sort()).toEqual(
        [
          "batch",
          "blocked",
          "created",
          "failed",
          "imagesAdded",
          "productIds",
          "unchanged",
          "updated",
          "variantsRemoved",
        ].sort(),
      );
    }
    const auditText = JSON.stringify(audit);
    const logText = logged.join("\n");
    for (const value of [...RESTRICTED_VALUES, WARNING_VALUE]) {
      expect(auditText).not.toContain(value);
      expect(logText).not.toContain(value);
    }
  });

  it("revalidates only catalog and product tags of written (draft) products", async () => {
    await stage();
    const plan = await preview();
    await commitAll(plan);
    const tags = nextCache.updateTag.mock.calls.map(([tag]) => tag as string);
    const ids = (await ProductModel.find({}, { _id: 1 }).lean()).map((p) =>
      p._id.toHexString(),
    );
    expect(new Set(tags)).toEqual(
      new Set(["products", ...ids.map((id) => `product:${id}`)]),
    );
    // Drafts: no category/area listing is expired.
    expect(nextCache.revalidateTag).not.toHaveBeenCalled();
  });

  it("re-importing the same file is a no-op through the actions", async () => {
    await stage();
    await commitAll(await preview());
    const before = await ProductModel.find({}).sort({ _id: 1 }).lean();
    const auditBefore = await AuditLogModel.countDocuments();
    vi.mocked(cloudinary.uploadImageBuffer).mockClear();
    nextCache.updateTag.mockClear();

    const again = await preview();
    expect(again.summary).toMatchObject({ create: 0, update: 0, unchanged: 3 });
    expect(batchesToSend(again.entries)).toEqual([]);
    // Even if the browser sent the batch anyway, nothing is written.
    const forced = await commitImportBatchAction(commitInput(again, 0));
    expect(forced).toMatchObject({
      ok: true,
      data: { summary: { unchanged: 3 } },
    });

    expect(await ProductModel.find({}).sort({ _id: 1 }).lean()).toEqual(before);
    expect(await AuditLogModel.countDocuments()).toBe(auditBefore);
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });
});

describe("gate C: restricted values in the admin's diff are marked", () => {
  it("every diff row that holds a restricted value is one the page marks Restricted", async () => {
    await stage();
    await commitAll(await preview());
    // The client sends a new sheet with every restricted value changed.
    await stage({
      "Batch No.": "QXBATCH88",
      "Chip Type": "QXCHIP88",
      Holder: "QXHOLDER88",
      "Chip Efficiency": "QXEFF88",
      Driver: "QXDRIVER88",
    });
    const plan = await preview();
    expect(plan.summary.update).toBe(3);

    // What the page computes (page.tsx): the restricted column keys.
    const visibility = await getColumnVisibility();
    const restricted = new Set(
      Object.entries(visibility)
        .filter(([, v]) => v === "restricted")
        .map(([k]) => k),
    );
    const changes = plan.entries.flatMap((e) => e.changes);
    const holding = changes.filter((c) =>
      /QX\w+(77|88)/.test(`${c.before ?? ""} ${c.after ?? ""}`),
    );
    expect(holding.length).toBeGreaterThan(0);
    for (const change of holding) {
      expect(isRestrictedChange(change, restricted), change.field).toBe(true);
    }
    // And nothing outside the diff (names, warnings, model nos.) holds them.
    const withoutDiff = JSON.stringify({
      ...plan,
      entries: plan.entries.map((e) => ({ ...e, changes: [] })),
    });
    expect(withoutDiff).not.toMatch(/QX\w+(77|88)/);
  });
});

describe("gate C: hostile inputs reach no storage call and no write", () => {
  const OPERATOR_INPUTS: [string, unknown][] = [
    [
      "operator object as key",
      { key: { $gt: "" }, defaultCategoryId: new ObjectId().toHexString() },
    ],
    [
      "operator object as category",
      { key: KEY, defaultCategoryId: { $ne: null } },
    ],
    [
      "datasheet key",
      {
        key: `datasheets/${new ObjectId().toHexString()}.xlsx`,
        defaultCategoryId: new ObjectId().toHexString(),
      },
    ],
    [
      "climbing key",
      {
        key: `imports/../datasheets/${randomUUID()}.xlsx`,
        defaultCategoryId: new ObjectId().toHexString(),
      },
    ],
    [
      "upper-case uuid",
      {
        key: KEY.toUpperCase()
          .replace("IMPORTS/", "imports/")
          .replace(".XLSX", ".xlsx"),
        defaultCategoryId: new ObjectId().toHexString(),
      },
    ],
    [
      "prototype pollution",
      JSON.parse(
        '{"key":"x","defaultCategoryId":"y","__proto__":{"polluted":1}}',
      ),
    ],
  ];

  it.each(OPERATOR_INPUTS)("preview refuses %s", async (_name, input) => {
    const result = await previewImportAction(input);
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(storage.getImportBytes).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each(OPERATOR_INPUTS)(
    "finish refuses %s and deletes nothing",
    async (_name, input) => {
      // finish takes only { key }: the same hostile key, without the category.
      const rest = { key: (input as { key?: unknown }).key };
      const result = await finishImportAction(rest);
      if ((rest as { key?: unknown }).key === KEY) {
        // The one valid key in the table: the delete is allowed.
        expect(result).toMatchObject({ ok: true });
        return;
      }
      expect(result).toMatchObject({ ok: false });
      expect(storage.deleteImportUpload).not.toHaveBeenCalled();
    },
  );

  it("commit refuses a forged actor field (the actor is always the session)", async () => {
    await stage();
    const plan = await preview();
    const forged = await commitImportBatchAction({
      ...commitInput(plan, 0),
      actorId: new ObjectId().toHexString(),
    });
    expect(forged).toMatchObject({ ok: false, saved: false });
    expect(await ProductModel.countDocuments()).toBe(0);
    expect(cloudinary.uploadImageBuffer).not.toHaveBeenCalled();
  });

  it("presign never signs a browser-chosen key", async () => {
    vi.mocked(storage.presignImportUpload).mockResolvedValue({
      url: "https://r2.test/x",
      headers: { "Content-Type": "x" },
      expiresIn: 300,
      key: KEY,
    });
    const refused = await presignImportUploadAction({
      fileName: "a.xlsx",
      size: 10,
      contentType: "",
      key: "datasheets/evil.xlsx",
    });
    expect(refused).toMatchObject({ ok: false });
    expect(storage.presignImportUpload).not.toHaveBeenCalled();
  });

  it("a customer reaches no service, even with a valid staged key", async () => {
    getSession.mockResolvedValue({
      session: { id: "s2" },
      user: {
        id: new ObjectId().toHexString(),
        email: "c@example.com",
        role: "customer",
        banned: false,
        banExpires: null,
        mustChangePassword: false,
        accessExpiresAt: null,
      },
    });
    await expect(
      previewImportAction({ key: KEY, defaultCategoryId: defaultCategory }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(finishImportAction({ key: KEY })).rejects.toThrow("FORBIDDEN");
    expect(storage.getImportBytes).not.toHaveBeenCalled();
    expect(storage.deleteImportUpload).not.toHaveBeenCalled();
  });
});

describe("gate C: limits and staged-file handling", () => {
  it("a commit of the largest plan fits the 1 MB Server Action body limit", () => {
    const input = {
      key: KEY,
      defaultCategoryId: new ObjectId().toHexString(),
      etag: '"' + "e".repeat(64) + '"',
      planHash: "a".repeat(64),
      entryHashes: Array.from({ length: MAX_IMPORT_PLAN_ENTRIES }, () =>
        "f".repeat(64),
      ),
      batch: 249,
      acknowledgeRemovals: true,
    };
    // Server Actions encode arguments roughly as JSON; keep 2x headroom.
    expect(JSON.stringify(input).length * 2).toBeLessThan(1024 * 1024);
  });

  it("a commit after the staged file expired tells the screen to upload again", async () => {
    await stage();
    const plan = await preview();
    vi.mocked(storage.getImportBytes).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    const answer = await commitImportBatchAction(commitInput(plan, 0));
    expect(answer).toMatchObject({ ok: false, saved: false });
    // Finding L-2 (known T9 follow-up): this maps to "retry", which can
    // never succeed; the staged file is gone, so "upload" is the way out.
    expect((answer as { next?: string }).next).toBe("upload");
  });

  it("L-1: an expired staged file sends the screen back to upload, not retry", async () => {
    await stage();
    const plan = await preview();
    vi.mocked(storage.getImportBytes).mockResolvedValue({
      ok: false,
      reason: "not_found",
    });
    const answer = await commitImportBatchAction(commitInput(plan, 0));
    expect((answer as { next?: string }).next).toBe("upload");
  });

  it("a preview refused as a whole carries no restricted value either", async () => {
    vi.mocked(storage.getImportBytes).mockResolvedValue({
      ok: true,
      bytes: new TextEncoder().encode(`not a zip ${RESTRICTED_VALUES[0]}`),
      etag: ETAG,
    });
    const result = await previewImportAction({
      key: KEY,
      defaultCategoryId: defaultCategory,
    });
    expect(result).toMatchObject({ ok: true, data: { kind: "refused" } });
    expect(JSON.stringify(result)).not.toContain(RESTRICTED_VALUES[0]);
    expect((result as { data: ImportPreviewView }).data.kind).toBe("refused");
  });
});
