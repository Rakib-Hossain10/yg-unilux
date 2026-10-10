// QA gate C (Phase 5 exit), independent of the builders' tests.
//
// 1. Datasheet route, speculative requests (ADR 0073 amendment): the 503
//    answer is byte-for-byte the same for every product id and every viewer
//    (no existence / datasheet / session oracle), and runs nothing: no
//    connection-dependent lookup, no session read, no limiter slot, no
//    presign, no log. A forged prefetch header only costs its sender a 503.
// 2. The one admin read outside src/lib/admin (datasheet uploader names) is
//    reachable only from the guarded datasheets page, and is not a Server
//    Action module, so the actor guard's scope (src/lib/admin) is not
//    bypassed through it.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  findDownloadProduct: vi.fn(),
  findDatasheetFile: vi.fn(),
  consumeDownload: vi.fn(),
  recordDownload: vi.fn(),
  getViewer: vi.fn(),
  presignGet: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/datasheet-download", () => ({
  findDownloadProduct: calls.findDownloadProduct,
  findDatasheetFile: calls.findDatasheetFile,
  consumeDownload: calls.consumeDownload,
  recordDownload: calls.recordDownload,
}));
vi.mock("@/lib/storage", () => ({ presignGet: calls.presignGet }));
vi.mock("@/lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/permissions")>()),
  getViewer: calls.getViewer,
}));

const { GET } = await import("@/app/api/datasheet/[productId]/route");

const PUBLISHED = "64b0000000000000000000a1";
const DRAFT = "64b0000000000000000000a2";
const UNKNOWN = "64b0000000000000000000a3";
const IDS = [PUBLISHED, DRAFT, UNKNOWN, "not-an-id", "%24ne", "{}"];

const PREFETCH_HEADERS: Record<string, string>[] = [
  { "sec-purpose": "prefetch" },
  { "sec-purpose": "prefetch;prerender" },
  { "sec-purpose": "prefetch;anonymous-client-ip" },
  { purpose: "prefetch" },
  { "x-moz": "prefetch" },
  { "x-purpose": "preview" },
  { "next-router-prefetch": "1" },
];

async function call(productId: string, headers: Record<string, string>) {
  const response = await GET(
    new Request(`http://localhost:3000/api/datasheet/${productId}`, {
      headers,
    }),
    { params: Promise.resolve({ productId }) },
  );
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: await response.text(),
  };
}

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockReset();
  calls.findDownloadProduct.mockImplementation(async (id: string) =>
    id === PUBLISHED
      ? { id, slug: "arc-ar-013a", datasheetId: "64b0000000000000000000d1" }
      : null,
  );
  calls.getViewer.mockResolvedValue({
    user: {
      id: "64b0000000000000000000c1",
      role: "customer",
      banned: false,
      mustChangePassword: false,
      accessExpiresAt: null,
    },
  });
  calls.findDatasheetFile.mockResolvedValue({
    id: "64b0000000000000000000d1",
    storageKey: "datasheets/x.xlsx",
    fileName: "x.xlsx",
  });
  calls.consumeDownload.mockResolvedValue({ allowed: true });
  calls.presignGet.mockResolvedValue({ url: "https://r2.example/signed" });
  calls.recordDownload.mockResolvedValue(undefined);
});

describe("datasheet route: speculative requests are a uniform, inert 503", () => {
  it("every id and every viewer gets the identical answer, and nothing runs", async () => {
    const answers = new Set<string>();
    for (const headers of PREFETCH_HEADERS) {
      for (const id of IDS) {
        for (const cookie of [
          {},
          { cookie: "better-auth.session_token=x" },
        ] as Record<string, string>[]) {
          answers.add(
            JSON.stringify(await call(id, { ...headers, ...cookie })),
          );
        }
      }
    }
    expect([...answers]).toEqual([
      JSON.stringify({
        status: 503,
        headers: [
          ["cache-control", "private, no-store"],
          ["retry-after", "0"],
        ],
        body: "",
      }),
    ]);
    for (const [name, fn] of Object.entries(calls)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
  });

  it("control: the same request without the header runs the pipeline", async () => {
    const answer = await call(PUBLISHED, {});
    expect(answer.status).toBe(303);
    expect(calls.getViewer).toHaveBeenCalledTimes(1);
    expect(calls.recordDownload).toHaveBeenCalledTimes(1);
  });

  it("a non-speculative 'purpose' value is not mistaken for a prefetch", async () => {
    for (const headers of [
      { purpose: "noprefetch" },
      { "sec-purpose": "prefetching" },
      { "next-router-prefetch": "0" },
    ] as Record<string, string>[]) {
      calls.recordDownload.mockClear();
      expect(
        (await call(PUBLISHED, headers)).status,
        JSON.stringify(headers),
      ).toBe(303);
      expect(calls.recordDownload).toHaveBeenCalledTimes(1);
    }
  });
});

describe("admin reads outside src/lib/admin stay behind the guarded page", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  function sourceFiles(dir: string): string[] {
    return readdirSync(path.join(root, dir), {
      recursive: true,
      withFileTypes: true,
    })
      .filter(
        (e) =>
          e.isFile() &&
          /\.(ts|tsx)$/.test(e.name) &&
          !/\.test\.(ts|tsx)$/.test(e.name),
      )
      .map((e) =>
        path
          .relative(root, path.join(e.parentPath, e.name))
          .replaceAll("\\", "/"),
      );
  }

  it("uploader-names is imported only by the datasheets page, which guards first", () => {
    const importers = [...sourceFiles("src"), ...sourceFiles("scripts")].filter(
      (file) =>
        /["'](?:\.\/|@\/app\/admin\/datasheets\/)uploader-names["']/.test(
          readFileSync(path.join(root, file), "utf8"),
        ),
    );
    expect(importers).toEqual(["src/app/admin/datasheets/page.tsx"]);
    const source = readFileSync(
      path.join(root, "src/app/admin/datasheets/uploader-names.ts"),
      "utf8",
    );
    expect(source).toMatch(/^import "server-only";$/m);
    expect(source).not.toMatch(/["']use server["']/);
    const page = readFileSync(
      path.join(root, "src/app/admin/datasheets/page.tsx"),
      "utf8",
    );
    // The labels are read only after the guarded service read.
    const guard = page.indexOf("await requireAdmin()");
    const service = page.indexOf("listDatasheets(");
    const labels = page.indexOf("uploaderLabels(");
    expect(guard).toBeGreaterThan(-1);
    expect(service).toBeGreaterThan(guard);
    expect(labels).toBeGreaterThan(service);
  });
});
