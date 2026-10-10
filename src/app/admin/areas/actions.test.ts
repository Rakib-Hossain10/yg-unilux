// Behavioural tests for the areas Server Actions on an in-memory MongoDB:
// a visitor, a customer, a banned admin and an admin on a temporary password
// change nothing; the admin's calls write, audit, revalidate and redirect.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createArea } from "@/lib/admin/areas";
import { AUDIT_FAILED_MESSAGE } from "@/lib/admin/write-result";
import { mongoose } from "@/lib/db";
import { AreaModel, ProductModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";
import { testActor } from "../../../../test/helpers/admin-actor";
import { setupMemoryDb } from "../../../../test/helpers/memory-db";

import {
  createAreaAction,
  deleteAreaAction,
  moveAreaAction,
  setAreaImageAction,
  signAreaImageUpload,
  updateAreaAction,
} from "./actions";

const getSession = vi.hoisted(() => vi.fn());
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
// When set, the audit write throws (the "saved but not audited" branch).
const auditFails = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: (
    await import("../../../../test/helpers/admin-actor")
  ).sessionsWithTestActors(getSession),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
// redirect() and forbidden() throw in Next; these throw a readable error.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));
vi.mock("next/cache", () => nextCache);
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    recordAudit: async (input: Parameters<typeof actual.recordAudit>[0]) => {
      if (auditFails.value) throw new Error("audit store down");
      return actual.recordAudit(input);
    },
  };
});

setupMemoryDb("yg_admin_area_actions_test");

const { ObjectId } = mongoose.Types;
const ADMIN_ID = new ObjectId().toHexString();
const seeder = testActor();
const SEED_ACTOR = seeder.id;

/* A Better Auth session user with the fields the guard reads. */
function signedInAs(fields: Record<string, unknown>) {
  getSession.mockResolvedValue({
    session: { id: "s1" },
    user: {
      id: ADMIN_ID,
      email: "someone@example.com",
      role: "admin",
      banned: false,
      banExpires: null,
      mustChangePassword: false,
      accessExpiresAt: null,
      ...fields,
    },
  });
}

let retail: string;
let office: string;

beforeEach(async () => {
  getSession.mockReset();
  nextCache.updateTag.mockReset();
  nextCache.refresh.mockReset();
  auditFails.value = false;
  await Promise.all([
    AreaModel.deleteMany({}),
    ProductModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  // Seeded through the service, as another admin, then the log is cleared
  // so each test sees only its own audit entries.
  retail = await seed("Retail");
  office = await seed("Office");
  await AuditLogModel.deleteMany({});
});

async function seed(name: string): Promise<string> {
  const result = await createArea(seeder, { name });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.data.id;
}

/* Everything an action could change, in a comparable form. */
async function snapshot() {
  const [areas, audit] = await Promise.all([
    AreaModel.find({}).sort({ _id: 1 }).lean(),
    AuditLogModel.countDocuments(),
  ]);
  return JSON.parse(JSON.stringify({ areas, audit })) as unknown;
}

/* One call of every action, each with valid input an admin could send. */
const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["create", () => createAreaAction({ name: "Hospitality" })],
  ["update", () => updateAreaAction(retail, { name: "Renamed" })],
  ["move", () => moveAreaAction(office, "up")],
  ["delete", () => deleteAreaAction(office)],
];

describe.each([
  ["a visitor", null, "REDIRECT /login"],
  ["a customer", { role: "customer" }, "FORBIDDEN"],
  ["a banned admin", { banned: true }, "FORBIDDEN"],
  [
    "an admin on a temporary password",
    { mustChangePassword: true },
    "REDIRECT /change-password",
  ],
])("as %s", (_who, user, outcome) => {
  beforeEach(() => {
    if (user === null) getSession.mockResolvedValue(null);
    else signedInAs(user);
  });

  it.each(EVERY_ACTION)(
    "%s is refused and changes nothing",
    async (_name, call) => {
      const before = await snapshot();
      await expect(call()).rejects.toThrow(outcome);
      expect(await snapshot()).toEqual(before);
      expect(nextCache.updateTag).not.toHaveBeenCalled();
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => signedInAs({}));

  it("create saves, audits with the session's id, revalidates and redirects", async () => {
    await expect(
      createAreaAction({ name: "Hospitality", slug: "", bwImage: "" }),
    ).rejects.toThrow("REDIRECT /admin/areas?notice=created");

    const row = await AreaModel.findOne({ name: "Hospitality" }).lean();
    expect(row?.slug).toBe("hospitality");
    const audit = await AuditLogModel.findOne({}).lean();
    expect(audit?.action).toBe("area.create");
    expect(String(audit?.actor)).toBe(ADMIN_ID);
    expect(nextCache.updateTag).toHaveBeenCalledWith("areas");
  });

  it("create returns field errors for invalid input and writes nothing", async () => {
    const before = await snapshot();
    const result = await createAreaAction({ name: "  " });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { fieldErrors: { name: [expect.any(String)] } },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("create refuses fields the form doesn't have (no mass assignment)", async () => {
    const before = await snapshot();
    const result = await createAreaAction({
      name: "Hospitality",
      order: -1,
      actor: SEED_ACTOR,
    });
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it("update saves and expires areas and products", async () => {
    await expect(
      updateAreaAction(retail, { name: "Shops", slug: "", bwImage: "" }),
    ).rejects.toThrow("REDIRECT /admin/areas?notice=updated");
    expect((await AreaModel.findById(retail).lean())?.name).toBe("Shops");
    expect(nextCache.updateTag).toHaveBeenCalledWith("areas");
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
  });

  it("update with nothing changed says so and revalidates nothing", async () => {
    await expect(
      updateAreaAction(retail, { name: "Retail", slug: "retail", bwImage: "" }),
    ).rejects.toThrow("REDIRECT /admin/areas?notice=unchanged");
    expect(nextCache.updateTag).not.toHaveBeenCalled();
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("update of an unknown id is a form error", async () => {
    const result = await updateAreaAction(new ObjectId().toHexString(), {
      name: "Ghost",
    });
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { formErrors: [expect.stringContaining("no longer exists")] },
    });
  });

  it("move swaps two areas, refreshes the list and returns ok", async () => {
    expect(await moveAreaAction(office, "up")).toEqual({ ok: true });
    const order = await AreaModel.find({}).sort({ order: 1 }).lean();
    expect(order.map((row) => row.name)).toEqual(["Office", "Retail"]);
    expect(nextCache.updateTag).toHaveBeenCalledWith("areas");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("move at the edge changes nothing and refreshes nothing", async () => {
    expect(await moveAreaAction(retail, "up")).toEqual({ ok: true });
    expect(nextCache.refresh).not.toHaveBeenCalled();
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it("move with a bad direction is refused", async () => {
    const before = await snapshot();
    const result = await moveAreaAction(retail, "sideways");
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  it("delete of an area used by products returns the blocker", async () => {
    await ProductModel.create({
      name: "Arc",
      slug: "arc-1",
      mainCategory: new ObjectId(),
      areas: [new ObjectId(retail)],
    });
    const before = await snapshot();
    const result = await deleteAreaAction(retail);
    expect(result).toMatchObject({
      ok: false,
      saved: false,
      errors: { formErrors: [expect.stringContaining("1 product uses")] },
    });
    expect(await snapshot()).toEqual(before);
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("delete of an unused area deletes, audits and redirects", async () => {
    await expect(deleteAreaAction(office)).rejects.toThrow(
      "REDIRECT /admin/areas?notice=deleted",
    );
    expect(await AreaModel.findById(office).lean()).toBeNull();
    expect((await AuditLogModel.findOne({}).lean())?.action).toBe(
      "area.delete",
    );
  });

  it("delete refuses an id that is an operator object", async () => {
    const before = await snapshot();
    const result = await deleteAreaAction({ $ne: null });
    expect(result).toMatchObject({ ok: false, saved: false });
    expect(await snapshot()).toEqual(before);
  });

  describe("when the audit write fails", () => {
    beforeEach(() => {
      auditFails.value = true;
    });

    it("create keeps the area, revalidates and reports saved", async () => {
      const result = await createAreaAction({ name: "Hospitality" });
      expect(result).toEqual({
        ok: false,
        saved: true,
        errors: { formErrors: [AUDIT_FAILED_MESSAGE], fieldErrors: {} },
      });
      expect(await AreaModel.exists({ name: "Hospitality" })).not.toBeNull();
      expect(nextCache.updateTag).toHaveBeenCalledWith("areas");
    });

    it("update keeps the edit and still expires its tags", async () => {
      const result = await updateAreaAction(retail, { name: "Shops" });
      expect(result).toMatchObject({ ok: false, saved: true });
      expect((await AreaModel.findById(retail).lean())?.name).toBe("Shops");
      expect(nextCache.updateTag).toHaveBeenCalledWith("areas");
      expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    });

    it("move keeps the new order and still refreshes the list", async () => {
      const result = await moveAreaAction(office, "up");
      expect(result).toMatchObject({ ok: false, saved: true });
      expect(nextCache.updateTag).toHaveBeenCalledWith("areas");
      expect(nextCache.refresh).toHaveBeenCalledOnce();
    });

    it("delete removes the row and still refreshes the list", async () => {
      const result = await deleteAreaAction(office);
      expect(result).toMatchObject({ ok: false, saved: true });
      expect(await AreaModel.findById(office).lean()).toBeNull();
      expect(nextCache.refresh).toHaveBeenCalledOnce();
    });
  });
});

const CALLS: [string, () => Promise<unknown>][] = [
  ["create", () => createAreaAction({ name: "Office", slug: "", bwImage: "" })],
  [
    "update",
    () => updateAreaAction(retail, { name: "Shops", slug: "", bwImage: "" }),
  ],
  ["move", () => moveAreaAction(retail, "down")],
  ["delete", () => deleteAreaAction(retail)],
  ["sign image", () => signAreaImageUpload(retail)],
  ["set image", () => setAreaImageAction({ areaId: retail, publicId: null })],
];

describe("a service that refuses the actor answers 403 (ADR 0073)", () => {
  beforeEach(async () => {
    signedInAs({});
    const admin: unknown = await getSession();
    // The services' own re-check from the database sees a customer (e.g.
    // demoted between the two reads); requireAdmin() still saw the admin.
    signedInAs({ role: "customer" });
    getSession.mockResolvedValueOnce(admin);
  });

  it.each(CALLS)("%s", async (_name, call) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const audits = await AuditLogModel.countDocuments();
    await expect(call()).rejects.toThrow("FORBIDDEN");
    // Refused by the service's check, not by requireAdmin().
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/actor refused: not_admin$/),
    );
    expect(await AuditLogModel.countDocuments()).toBe(audits);
  });
});
