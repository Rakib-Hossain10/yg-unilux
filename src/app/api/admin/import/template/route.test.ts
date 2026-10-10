// Tests for GET /api/admin/import/template: the 401/403/200 matrix (session
// mocked, database real in memory), the download headers, and that the body
// passes the import safety check and mirrors the live categories and areas.

import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkImportFile } from "@/lib/import/safety";
import { AreaModel, CategoryModel } from "@/models";
import { setupMemoryDb } from "../../../../../../test/helpers/memory-db";

import { GET } from "./route";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));

setupMemoryDb("yg_import_template_route_test");

const sessionFor = (fields: Record<string, unknown>) =>
  getSession.mockResolvedValue({
    session: { id: "s1" },
    user: {
      id: "64b000000000000000000001",
      role: "admin",
      banned: false,
      banExpires: null,
      mustChangePassword: false,
      accessExpiresAt: null,
      ...fields,
    },
  });

beforeEach(async () => {
  getSession.mockReset();
  await Promise.all([CategoryModel.deleteMany({}), AreaModel.deleteMany({})]);
});

async function headerRow(response: Response): Promise<string[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    Buffer.from(await response.arrayBuffer()) as unknown as ExcelJS.Buffer,
  );
  const values = workbook.getWorksheet("Products")?.getRow(1).values;
  return (Array.isArray(values) ? values : [])
    .filter((v) => v !== undefined && v !== null)
    .map(String);
}

describe("GET /api/admin/import/template access", () => {
  it("answers 401 with no session", async () => {
    getSession.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers 403 for a customer", async () => {
    sessionFor({ role: "customer" });
    expect((await GET()).status).toBe(403);
  });

  it("answers 403 for a banned admin", async () => {
    sessionFor({ banned: true });
    expect((await GET()).status).toBe(403);
  });

  it("answers 403 for an admin still on a temporary password", async () => {
    sessionFor({ mustChangePassword: true });
    expect((await GET()).status).toBe(403);
  });

  it("answers 403 when the services then refuse the actor (ADR 0073)", async () => {
    // The route's own check sees an admin; the services' re-check from the
    // database sees a customer (e.g. demoted in between).
    sessionFor({ role: "customer" });
    getSession.mockResolvedValueOnce({
      session: { id: "s1" },
      user: {
        id: "64b000000000000000000001",
        role: "admin",
        banned: false,
        banExpires: null,
        mustChangePassword: false,
        accessExpiresAt: null,
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(warn).not.toHaveBeenCalled(); // reads throw; nothing is logged
  });
});

describe("GET /api/admin/import/template download", () => {
  it("sends an uncached xlsx attachment that passes the safety check", async () => {
    sessionFor({});
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="yg-unilux-import-template.xlsx"',
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get("Content-Length"))).toBe(bytes.length);
    expect((await checkImportFile(bytes)).ok).toBe(true);
  });

  it("reflects the live areas in the header row, in admin order", async () => {
    sessionFor({});
    await AreaModel.create([
      { name: "Retail", slug: "retail", order: 1 },
      { name: "Residential", slug: "residential", order: 0 },
    ]);
    const headers = await headerRow(await GET());
    const areaHeaders = headers.filter((h) => h.startsWith("Area: "));
    expect(areaHeaders).toEqual(["Area: Residential", "Area: Retail"]);
  });

  it("reflects the live category tree in the Category dropdown list", async () => {
    sessionFor({});
    const main = await CategoryModel.create({
      name: "Magnetic Track",
      slug: "magnetic-track",
      parent: null,
      order: 0,
    });
    await CategoryModel.create({
      name: "Linear",
      slug: "linear",
      parent: main._id,
      order: 0,
    });
    const response = await GET();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(await response.arrayBuffer()) as unknown as ExcelJS.Buffer,
    );
    const lists = workbook.getWorksheet("Lists");
    expect(lists?.getCell(2, 1).value).toBe("Magnetic Track");
    expect(lists?.getCell(3, 1).value).toBe("Magnetic Track > Linear");
    expect(lists?.getCell(4, 1).value).toBeNull();
  });
});
