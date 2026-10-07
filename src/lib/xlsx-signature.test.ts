// Tests for the .xlsx content check: a real workbook passes; a zip that is
// not a workbook, plain text, a truncated file, an oversized file and a zip
// with too many entries are all refused, whatever the file was named.

import { deflateRawSync, inflateRawSync } from "node:zlib";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import { MAX_DATASHEET_BYTES, MAX_XLSX_ENTRIES } from "./constants";

// The real zlib, with inflateRawSync observable (to prove the output cap
// stops the inflate itself, not only the size check after it).
vi.mock("node:zlib", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:zlib")>();
  return { ...real, inflateRawSync: vi.fn(real.inflateRawSync) };
});
import { localRecord } from "../../test/fixtures/import/raw-zip";
import {
  checkXlsx,
  readCentralDirectory,
  readZipBytes,
  readZipPart,
  type CentralEntry,
} from "./xlsx-signature";

async function realWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Specs");
  sheet.addRow(["NO.", "Model Name"]);
  sheet.addRow([1, "Arc"]);
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function zipOf(
  files: Record<string, string>,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array", compression });
}

const WORKBOOK_TYPES =
  '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';

describe("checkXlsx", () => {
  it("accepts a workbook written by exceljs", async () => {
    expect(await checkXlsx(await realWorkbook())).toEqual({ ok: true });
  });

  it("accepts stored (uncompressed) parts too", async () => {
    const bytes = await zipOf(
      { "[Content_Types].xml": WORKBOOK_TYPES, "xl/workbook.xml": "<w/>" },
      "STORE",
    );
    expect(await checkXlsx(bytes)).toEqual({ ok: true });
  });

  it("refuses an empty file", async () => {
    expect(await checkXlsx(new Uint8Array(0))).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("refuses plain text renamed to .xlsx", async () => {
    const bytes = new TextEncoder().encode(
      "hello, this is not a workbook ".repeat(5),
    );
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_zip" });
  });

  it("refuses a zip that is not a workbook (renamed .zip)", async () => {
    const bytes = await zipOf({ "readme.txt": "just a zip" });
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_xlsx" });
  });

  it("refuses a zip with the parts but no workbook content type", async () => {
    const bytes = await zipOf({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": "<w/>",
    });
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_xlsx" });
  });

  it("refuses a macro-enabled workbook (.xlsm)", async () => {
    const bytes = await zipOf({
      "[Content_Types].xml": WORKBOOK_TYPES.replace(
        "sheet.main+xml",
        "sheet.macroEnabled.main+xml",
      ),
      "xl/workbook.xml": "<w/>",
    });
    expect(await checkXlsx(bytes)).toEqual({ ok: false, reason: "not_xlsx" });
  });

  it("refuses a truncated zip", async () => {
    const whole = await realWorkbook();
    const cut = whole.subarray(0, Math.floor(whole.length / 2));
    expect(await checkXlsx(cut)).toEqual({ ok: false, reason: "corrupt" });
  });

  it("refuses a file over the size limit", async () => {
    const big = new Uint8Array(MAX_DATASHEET_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    expect(await checkXlsx(big)).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a zip with too many entries, before reading them", async () => {
    const files: Record<string, string> = {
      "[Content_Types].xml": WORKBOOK_TYPES,
      "xl/workbook.xml": "<w/>",
    };
    for (let i = 0; i < MAX_XLSX_ENTRIES; i++) files[`f/${i}.txt`] = "";
    const bytes = await zipOf(files, "STORE");
    expect(await checkXlsx(bytes)).toEqual({
      ok: false,
      reason: "too_many_entries",
    });
  });

  it("refuses a content type part that inflates past the cap", async () => {
    const bomb = `${WORKBOOK_TYPES}${" ".repeat(3 * 1024 * 1024)}`;
    const bytes = await zipOf({
      "[Content_Types].xml": bomb,
      "xl/workbook.xml": "<w/>",
    });
    expect((await checkXlsx(bytes)).ok).toBe(false);
  });

  it("refuses a directory whose offsets point outside the file", async () => {
    const bytes = await realWorkbook();
    const broken = new Uint8Array(bytes);
    // Central directory offset field of the end record: past the end.
    const view = new DataView(broken.buffer);
    for (let i = broken.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        view.setUint32(i + 16, broken.length - 1, true);
        break;
      }
    }
    expect(await checkXlsx(broken)).toEqual({ ok: false, reason: "corrupt" });
  });
});

/*
 * The central-directory reader is shared with the import safety check
 * (src/lib/import/safety.ts), which needs its own entry cap.
 */
describe("readCentralDirectory", () => {
  it("lists entry names and declared sizes without inflating", async () => {
    const bytes = await zipOf({ "a.txt": "x".repeat(1000), "b/c.xml": "<c/>" });
    const parsed = readCentralDirectory(bytes, {
      maxEntries: 10,
      trailer: "none",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries.map((e) => e.name)).toEqual([
      "a.txt",
      "b/",
      "b/c.xml",
    ]);
    expect(parsed.entries[0]?.uncompressedSize).toBe(1000);
    expect(parsed.entries[0]?.method).toBe(8);
    expect(parsed.entries[0]?.compressedSize).toBeLessThan(1000);
  });

  it("applies the caller's entry cap", async () => {
    const bytes = await zipOf({ a: "1", b: "2", c: "3" }, "STORE");
    expect(
      readCentralDirectory(bytes, { maxEntries: 2, trailer: "none" }),
    ).toEqual({
      ok: false,
      reason: "too_many_entries",
    });
    expect(
      readCentralDirectory(bytes, { maxEntries: 3, trailer: "none" }).ok,
    ).toBe(true);
  });

  it("calls a file with no end record corrupt", () => {
    expect(
      readCentralDirectory(new Uint8Array(100), {
        maxEntries: 10,
        trailer: "none",
      }),
    ).toEqual({ ok: false, reason: "corrupt" });
  });
});

/*
 * Inserts `gap` bytes between the central directory and the end record of a
 * zip and returns the result. With `zip64`, the gap is a consistent zip64 end
 * record + locator, as some Open XML writers emit for small files.
 */
function withGap(bytes: Uint8Array, kind: "zip64" | "junk"): Uint8Array {
  const eocd = bytes.length - 22;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  const gap = new Uint8Array(76);
  if (kind === "zip64") {
    const g = new DataView(gap.buffer);
    g.setUint32(0, 0x06064b50, true);
    g.setBigUint64(4, BigInt(44), true);
    g.setBigUint64(40, BigInt(size), true);
    g.setBigUint64(48, BigInt(offset), true);
    g.setUint32(56, 0x07064b50, true);
    g.setBigUint64(64, BigInt(eocd), true);
    g.setUint32(72, 1, true);
  }
  const out = new Uint8Array(bytes.length + gap.length);
  out.set(bytes.subarray(0, eocd));
  out.set(gap, eocd);
  out.set(bytes.subarray(eocd), eocd + gap.length);
  return out;
}

describe("readCentralDirectory trailer rule", () => {
  it("accepts a consistent zip64 trailer only when allowed", async () => {
    const bytes = withGap(await realWorkbook(), "zip64");
    expect(
      readCentralDirectory(bytes, {
        maxEntries: 1000,
        trailer: "zip64-trailer",
      }).ok,
    ).toBe(true);
    expect(
      readCentralDirectory(bytes, { maxEntries: 100, trailer: "none" }),
    ).toEqual({ ok: false, reason: "corrupt" });
  });

  it("refuses any other gap before the end record", async () => {
    const bytes = withGap(await realWorkbook(), "junk");
    expect(
      readCentralDirectory(bytes, {
        maxEntries: 1000,
        trailer: "zip64-trailer",
      }),
    ).toEqual({ ok: false, reason: "corrupt" });
  });

  it("keeps accepting datasheets that carry a zip64 trailer", async () => {
    expect(await checkXlsx(withGap(await realWorkbook(), "zip64"))).toEqual({
      ok: true,
    });
  });

  it("refuses a stored content-types part whose size does not match", async () => {
    const bytes = await zipOf(
      { "[Content_Types].xml": WORKBOOK_TYPES, "xl/workbook.xml": "<w/>" },
      "STORE",
    );
    const out = new Uint8Array(bytes);
    const view = new DataView(out.buffer);
    for (let at = out.length - 22; at >= 0; at--) {
      if (view.getUint32(at, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(at + 28, true);
      const name = new TextDecoder().decode(
        out.subarray(at + 46, at + 46 + nameLength),
      );
      if (name === "[Content_Types].xml") {
        view.setUint32(at + 24, 10, true);
        break;
      }
    }
    expect(await checkXlsx(out)).toEqual({ ok: false, reason: "corrupt" });
  });
});

describe("readZipBytes / readZipPart", () => {
  /* One local record (header + data) and a matching directory entry. */
  function part(
    payload: Uint8Array,
    {
      method = 8,
      flags = 0,
      declared,
    }: { method?: number; flags?: number; declared?: number } = {},
  ): { bytes: Uint8Array; entry: CentralEntry } {
    const data = method === 8 ? deflateRawSync(payload) : payload;
    const bytes = localRecord("p.bin", data);
    const name = new TextEncoder().encode("p.bin");
    return {
      bytes,
      entry: {
        name: "p.bin",
        nameBytes: name,
        extraFieldIds: [],
        flags,
        method,
        compressedSize: data.length,
        uncompressedSize: declared ?? payload.length,
        localOffset: 0,
      },
    };
  }

  const payload = Uint8Array.from({ length: 4096 }, (_, i) => i % 7);

  it("round-trips a deflated and a stored part", () => {
    const deflated = part(payload);
    expect(readZipBytes(deflated.bytes, deflated.entry, 10_000)).toEqual(
      Buffer.from(payload),
    );
    const stored = part(payload, { method: 0 });
    expect(
      Buffer.from(
        readZipBytes(stored.bytes, stored.entry, 10_000) as Uint8Array,
      ),
    ).toEqual(Buffer.from(payload));
  });

  it("calls a part corrupt when its size differs from the directory", () => {
    const smaller = part(payload, { declared: 100 });
    expect(readZipBytes(smaller.bytes, smaller.entry, 10_000)).toBe("corrupt");
    const larger = part(payload, { declared: 5000 });
    expect(readZipBytes(larger.bytes, larger.entry, 10_000)).toBe("corrupt");
    const stored = part(payload, { method: 0, declared: 4000 });
    expect(readZipBytes(stored.bytes, stored.entry, 10_000)).toBe("corrupt");
  });

  it("stops inflating at the cap even when the directory lies", () => {
    const inflate = vi.mocked(inflateRawSync);
    inflate.mockClear();
    const lying = part(payload, { declared: 100 });
    expect(readZipBytes(lying.bytes, lying.entry, 1000)).toBe("corrupt");
    expect(inflate).toHaveBeenCalledTimes(1);
    expect(inflate.mock.calls[0]?.[1]).toMatchObject({ maxOutputLength: 1000 });
    // zlib itself refused to go past the cap (it threw), long before 4096 B.
    expect(inflate.mock.results[0]?.type).toBe("throw");
  });

  it("refuses an over-cap, encrypted or unknown-method part without reading it", () => {
    const big = part(payload);
    expect(readZipBytes(big.bytes, big.entry, 4095)).toBeNull();
    expect(readZipBytes(big.bytes, big.entry, 4096)).not.toBeNull();
    const encrypted = part(payload, { flags: 1 });
    expect(readZipBytes(encrypted.bytes, encrypted.entry, 10_000)).toBeNull();
    const method12 = part(payload, { method: 12 });
    expect(readZipBytes(method12.bytes, method12.entry, 10_000)).toBeNull();
  });

  it("readZipPart decodes UTF-8 text and passes corrupt / null through", () => {
    const text = part(new TextEncoder().encode("Lifud 莱福德"));
    expect(readZipPart(text.bytes, text.entry, 1000)).toBe("Lifud 莱福德");
    const lying = part(payload, { declared: 100 });
    expect(readZipPart(lying.bytes, lying.entry, 10_000)).toBe("corrupt");
    const encrypted = part(payload, { flags: 1 });
    expect(readZipPart(encrypted.bytes, encrypted.entry, 10_000)).toBeNull();
  });
});
