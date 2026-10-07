// QA gate E (Phase 2 exit): checks the earlier gates did not make. The e2e
// fake-provider preload can never switch on outside the Playwright test server
// (static scan + behaviour in a child process, lookalike hosts), a datasheet
// is stored only as the bytes that were verified (incoming object swapped
// between the check and the copy), and the T17 sweep is dry-run by default
// with strict argument parsing. Never touches a real R2, Cloudinary or Atlas.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { finalizeDatasheet } from "@/lib/admin/datasheets";
import { mongoose } from "@/lib/db";
import {
  applySelection,
  parseSweepArgs,
  selectOrphanImages,
} from "@/lib/orphan-sweep";
import { checkXlsx } from "@/lib/xlsx-signature";
import { DatasheetModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";

import { setupMemoryDb } from "./helpers/memory-db";
import { testPublicId } from "./helpers/public-ids";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRELOAD = path.join(root, "e2e", "fake-providers", "preload.mjs");

/* ------------------------------------------------------------------------ */
/* e2e fake-provider preload: never active outside the e2e test server       */
/* ------------------------------------------------------------------------ */

/* Every file git tracks (or would), minus the e2e folder and docs. */
function trackedFiles(): string[] {
  const out = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(out.status).toBe(0);
  return out.stdout.split(/\r?\n/).filter((file) => file !== "");
}

describe("e2e fake-provider preload stays out of the app", () => {
  it("only e2e/ (and this QA file) mention the preload or its switch", () => {
    const allowed = (file: string) =>
      file.startsWith("e2e/") ||
      file.startsWith("doc/") ||
      file.startsWith(".claude/") ||
      file === "test/phase2-exit.qa.test.ts";
    const offenders = trackedFiles()
      .filter((file) => !allowed(file))
      .filter((file) => /\.(m?[jt]sx?|json|ya?ml|cjs)$/.test(file))
      .filter((file) => existsSync(path.join(root, file)))
      .filter((file) =>
        /fake-providers|E2E_FAKE_PROVIDERS_PORT|preload\.mjs/.test(
          readFileSync(path.join(root, file), "utf8"),
        ),
      );
    expect(offenders).toEqual([]);
  });

  it("no npm script except the e2e runner adds a Node preload or NODE_OPTIONS", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const name of ["dev", "build", "start"]) {
      expect(pkg.scripts[name]).toBeDefined();
      expect(pkg.scripts[name]).not.toMatch(/--import|--require|NODE_OPTIONS/);
    }
    // No vercel.json build override that could add a preload.
    const vercel = path.join(root, "vercel.json");
    if (existsSync(vercel)) {
      expect(readFileSync(vercel, "utf8")).not.toMatch(
        /NODE_OPTIONS|--import|fake-providers/,
      );
    }
  });

  it("the built server output (when present) never names the switch", () => {
    const server = path.join(root, ".next", "server");
    if (!existsSync(server)) return;
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(js|json|html|rsc)$/.test(name) && stat.size < 5_000_000) {
          if (
            /E2E_FAKE_PROVIDERS_PORT|fake-providers/.test(
              readFileSync(full, "utf8"),
            )
          ) {
            hits.push(path.relative(root, full));
          }
        }
      }
    };
    walk(server);
    expect(hits).toEqual([]);
  });

  /*
   * Loads the real preload in a fresh Node process whose http/https request
   * functions are recorders, then reports whether https.request was replaced
   * and where each call went ("fake" = loopback http, "real" = untouched).
   */
  function runPreload(port: string | undefined): {
    patched: boolean;
    calls: { to: "fake" | "real"; host: string; e2eHost?: string }[];
  } {
    const script = `
      import http from "node:http";
      import https from "node:https";
      const calls = [];
      const hostOf = (a) => a instanceof URL ? a.hostname
        : typeof a === "string" ? new URL(a).hostname
        : String(a.hostname ?? a.host ?? "");
      const real = function (a) { calls.push({ to: "real", host: hostOf(a) }); return {}; };
      https.request = real;
      http.request = function (o) {
        calls.push({ to: "fake", host: String(o.hostname), e2eHost: o.headers?.["x-e2e-host"] });
        return {};
      };
      await import(${JSON.stringify(pathToFileURL(PRELOAD).href)});
      const patched = https.request !== real;
      for (const hostname of [
        "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        "api.cloudinary.com",
        "api.cloudinary.com:443",
        "api.cloudinary.com.evil.test",
        "evilr2.cloudflarestorage.com",
        "r2.cloudflarestorage.com.evil.test",
        "x.api.cloudinary.com",
        "res.cloudinary.com",
        "api.resend.com",
        "cluster0.mongodb.net",
      ]) https.request({ hostname, path: "/" }, () => {});
      https.request(new URL("https://acct.r2.cloudflarestorage.com/b/k"), { method: "PUT" }, () => {});
      https.request("https://api.cloudinary.com.evil.test/v1_1/x", () => {});
      console.log(JSON.stringify({ patched, calls }));
    `;
    // The child needs a copy of this process's environment (PATH, SystemRoot)
    // with the switch set or removed; nothing here reads a secret.
    // eslint-disable-next-line no-restricted-properties
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.E2E_FAKE_PROVIDERS_PORT;
    delete env.NODE_OPTIONS;
    if (port !== undefined) env.E2E_FAKE_PROVIDERS_PORT = port;
    const out = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env, encoding: "utf8" },
    );
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    return JSON.parse(out.stdout.trim()) as ReturnType<typeof runPreload>;
  }

  it("without E2E_FAKE_PROVIDERS_PORT it changes nothing: every call is real", () => {
    const result = runPreload(undefined);
    expect(result.patched).toBe(false);
    expect(result.calls.every((call) => call.to === "real")).toBe(true);
  });

  it.each(["", "0", "-1", "abc", "3110.5"])(
    "a malformed port (%j) leaves https.request alone",
    (port) => {
      expect(runPreload(port).patched).toBe(false);
    },
  );

  it("when on, only the exact R2 and Cloudinary API hosts go to loopback; lookalikes stay real", () => {
    const { patched, calls } = runPreload("3110");
    expect(patched).toBe(true);
    const fake = calls.filter((c) => c.to === "fake").map((c) => c.e2eHost);
    const real = calls.filter((c) => c.to === "real").map((c) => c.host);
    expect(fake).toEqual([
      "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      "api.cloudinary.com",
      "api.cloudinary.com",
      "acct.r2.cloudflarestorage.com",
    ]);
    // Redirected calls only ever reach 127.0.0.1.
    expect(
      calls.filter((c) => c.to === "fake").every((c) => c.host === "127.0.0.1"),
    ).toBe(true);
    expect(real).toEqual([
      "api.cloudinary.com.evil.test",
      "evilr2.cloudflarestorage.com",
      "r2.cloudflarestorage.com.evil.test",
      "x.api.cloudinary.com",
      "res.cloudinary.com",
      "api.resend.com",
      "cluster0.mongodb.net",
      "api.cloudinary.com.evil.test",
    ]);
  });
});

/* ------------------------------------------------------------------------ */
/* Datasheet finalize: the stored bytes are the verified bytes               */
/* ------------------------------------------------------------------------ */

const bucket = vi.hoisted(() => ({
  objects: new Map<string, Uint8Array>(),
  /** Runs right after the service read the incoming bytes (a rival PUT). */
  afterGet: undefined as undefined | ((key: string) => void),
}));
vi.mock("@/lib/storage", () => ({
  presignPut: vi.fn(),
  headObject: vi.fn(async (key: string) => {
    const bytes = bucket.objects.get(key);
    return bytes ? { size: bytes.length, contentType: undefined } : null;
  }),
  getObjectBytes: vi.fn(async (key: string) => {
    const bytes = bucket.objects.get(key) ?? null;
    bucket.afterGet?.(key);
    return bytes;
  }),
  copyObject: vi.fn(async (from: string, to: string) => {
    const bytes = bucket.objects.get(from);
    if (!bytes) throw new Error("no source");
    bucket.objects.set(to, bytes);
  }),
  deleteObject: vi.fn(async (key: string) => {
    bucket.objects.delete(key);
  }),
}));

setupMemoryDb("yg_phase2_exit_qa_test");

const ADMIN = new mongoose.Types.ObjectId().toHexString();
const INCOMING = "incoming/dddddddd-dddd-4ddd-8ddd-dddddddddddd.xlsx";

async function workbook(): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Specs").addRow(["NO.", "Model"]);
  return new Uint8Array(await book.xlsx.writeBuffer());
}

describe("finalizeDatasheet stores only what it verified", () => {
  beforeEach(async () => {
    bucket.objects.clear();
    bucket.afterGet = undefined;
    await DatasheetModel.deleteMany({});
    await AuditLogModel.deleteMany({});
  });

  it("control: a plain upload stores the verified workbook", async () => {
    const good = await workbook();
    bucket.objects.set(INCOMING, good);
    const result = await finalizeDatasheet(ADMIN, {
      mode: "new",
      incomingKey: INCOMING,
      fileName: "family.xlsx",
    });
    expect(result.ok).toBe(true);
    const row = await DatasheetModel.findOne().lean();
    expect(bucket.objects.get(String(row?.storageKey))).toEqual(good);
  });

  /*
   * The presigned PUT stays valid for 5 minutes and signs only the length and
   * type, so whoever holds it can PUT again (same size, other bytes) between
   * the service's read and its CopyObject. The copy then stores bytes that
   * were never checked. Fix: CopyObject with CopySourceIfMatch on the ETag
   * from HEAD, or PutObject the verified buffer instead of copying.
   * `it.fails` turns into `it` once fixed.
   */
  it.fails(
    "an incoming object swapped after the check is not what gets stored",
    async () => {
      const good = await workbook();
      const evil = new Uint8Array(good.length).fill(0x3c); // "<<<<": not a zip
      expect((await checkXlsx(evil)).ok).toBe(false);
      bucket.objects.set(INCOMING, good);
      bucket.afterGet = (key) => {
        if (key === INCOMING) bucket.objects.set(INCOMING, evil);
      };
      const result = await finalizeDatasheet(ADMIN, {
        mode: "new",
        incomingKey: INCOMING,
        fileName: "family.xlsx",
      });
      const row = await DatasheetModel.findOne().lean();
      const stored = row ? bucket.objects.get(row.storageKey) : undefined;
      // Either refused, or what is stored passes the signature check.
      if (result.ok) {
        expect(stored).toBeDefined();
        expect((await checkXlsx(stored!)).ok).toBe(true);
      } else {
        expect(row).toBeNull();
      }
    },
  );
});

/* ------------------------------------------------------------------------ */
/* T17 sweep: dry run by default, strict flags                               */
/* ------------------------------------------------------------------------ */

describe("orphan sweep safety", () => {
  it("no argument is a dry run", () => {
    expect(parseSweepArgs([])).toEqual({ apply: false });
  });

  it.each([
    "--apply=true",
    "--APPLY",
    "-a",
    "apply",
    "--apply ",
    "--force",
    "--dry-run",
  ])("rejects %j instead of guessing", (arg) => {
    expect("error" in parseSweepArgs([arg])).toBe(true);
  });

  it("a dry run never calls the delete function", async () => {
    const remove = vi.fn(async () => true);
    const result = await applySelection(["a", "b"], false, remove);
    expect(remove).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.selected).toEqual(["a", "b"]);
  });

  /*
   * Characterises the hazard behind the gate E finding: the selection trusts
   * the reference set completely. Pointed at the wrong (or an empty) database
   * while CLOUDINARY_URL names the shared cloud, `--apply` would select every
   * product and area image older than 24 h. There is no guard in the script.
   */
  it("hazard: an empty reference set selects every old product/area image", () => {
    const now = new Date("2026-10-07T00:00:00Z");
    const old = new Date("2026-09-01T00:00:00Z");
    const assets = [
      { publicId: testPublicId(1), createdAt: old },
      { publicId: testPublicId(2), createdAt: old },
      {
        publicId: testPublicId(3, "0123456789abcdef01234568", "area"),
        createdAt: old,
      },
    ];
    const selected = selectOrphanImages(assets, new Set(), now);
    expect(selected).toHaveLength(assets.length);
  });
});
