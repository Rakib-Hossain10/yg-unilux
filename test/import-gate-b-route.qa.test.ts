// Phase 3 QA gate B: extra access cases for GET /api/admin/import/template
// (rule 3): ban expiry both ways, missing/odd role and password flags, a
// session lookup that throws, and that no 4xx/5xx path leaks the workbook.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/admin/import/template/route";
import { AreaModel, CategoryModel } from "@/models";

import { setupMemoryDb } from "./helpers/memory-db";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));

setupMemoryDb("yg_import_gate_b_route_qa");

const admin = {
  id: "64b000000000000000000001",
  role: "admin",
  banned: false,
  banExpires: null,
  mustChangePassword: false,
  accessExpiresAt: null,
};

const as = (fields: Record<string, unknown>) =>
  getSession.mockResolvedValue({
    session: { id: "s1" },
    user: { ...admin, ...fields },
  });

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  getSession.mockReset();
  await Promise.all([CategoryModel.deleteMany({}), AreaModel.deleteMany({})]);
});

async function expectRefused(status: 401 | 403) {
  const response = await GET();
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Content-Disposition")).toBeNull();
  expect(response.headers.get("Content-Type")).not.toMatch(/spreadsheet/);
}

describe("gate B: template route access matrix", () => {
  it("allows an admin whose ban has expired", async () => {
    as({ banned: true, banExpires: new Date(Date.now() - DAY) });
    expect((await GET()).status).toBe(200);
  });

  it("refuses an admin banned until a future date", async () => {
    as({ banned: true, banExpires: new Date(Date.now() + DAY) });
    await expectRefused(403);
  });

  it("refuses an unreadable ban date (fails closed)", async () => {
    as({ banned: true, banExpires: "not a date" });
    await expectRefused(403);
  });

  it("refuses a missing mustChangePassword flag (fails closed)", async () => {
    as({ mustChangePassword: undefined });
    await expectRefused(403);
  });

  it.each([undefined, "", "Admin", "ADMIN", "customer", "customer,editor"])(
    "refuses role %j",
    async (role) => {
      as({ role });
      await expectRefused(403);
    },
  );

  it("refuses a session without a user as signed out", async () => {
    getSession.mockResolvedValue(null);
    await expectRefused(401);
  });

  it("does not answer with the workbook when the session lookup throws", async () => {
    getSession.mockRejectedValue(new Error("db down"));
    await expect(GET()).rejects.toThrow();
  });
});
