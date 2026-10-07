// Tests for the import file pre-check: a real workbook passes; zip bombs (by
// ratio, by total declared size, by lying sizes, by overlapping entries), too
// many entries, macro workbooks, non-zips and truncated files are refused.

import { crc32 } from "node:zlib";

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_MERGES,
  MAX_IMPORT_UNCOMPRESSED_BYTES,
} from "@/lib/constants";
import { readCentralDirectory } from "@/lib/xlsx-signature";

import { buildFixture } from "../../../test/fixtures/import/build";
import {
  checked,
  digestsOf,
  partsOf,
} from "../../../test/fixtures/import/checked";
import { patchZip } from "../../../test/fixtures/import/patch-zip";
import {
  extraField,
  localRecord,
  rawZip,
  type RawEntry,
} from "../../../test/fixtures/import/raw-zip";
import {
  IMPORT_SAFETY_MESSAGES,
  checkImportFile,
  safetyWarning,
  type ImportSafetyRejection,
} from "./safety";
import { readWorkbook } from "./workbook";

const WORKBOOK_TYPES =
  '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';

async function zipOf(
  files: Record<string, string | Uint8Array>,
  compression: "DEFLATE" | "STORE" = "DEFLATE",
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array", compression });
}

/** A minimal valid workbook skeleton plus extra parts. */
function workbookParts(
  extra: Record<string, string | Uint8Array> = {},
): Record<string, string | Uint8Array> {
  return {
    "[Content_Types].xml": WORKBOOK_TYPES,
    "xl/workbook.xml": "<workbook/>",
    ...extra,
  };
}

/*
 * Rewrites the declared uncompressed size of one entry in the central
 * directory, so a test can build a zip that lies about its sizes.
 */
function patchDeclaredSize(
  bytes: Uint8Array,
  name: string,
  size: number,
): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let at = 0; at + 46 < out.length; at++) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(at + 28, true);
    const entryName = new TextDecoder().decode(
      out.subarray(at + 46, at + 46 + nameLength),
    );
    if (entryName === name) {
      view.setUint32(at + 24, size, true);
      return out;
    }
  }
  throw new Error(`entry ${name} not found`);
}

async function reasonOf(bytes: Uint8Array) {
  const result = await checkImportFile(bytes);
  return result.ok ? "ok" : result.reason;
}

describe("checkImportFile", () => {
  it("accepts the synthetic client sheet and lists its entries", async () => {
    const result = await checkImportFile(await buildFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entryNames).toContain("xl/workbook.xml");
    expect(result.entryNames.some((n) => n.startsWith("xl/media/"))).toBe(true);
  });

  it("accepts a workbook written by exceljs", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRow(["NO.", "Model No."]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    expect(await reasonOf(bytes)).toBe("ok");
  });

  it("accepts folder entries (names ending in /, size 0)", async () => {
    const bytes = await zipOf(workbookParts({ "xl/media/a.bin": "x" }));
    const result = await checkImportFile(bytes);
    expect(result.ok && result.entryNames).toContain("xl/media/");
  });

  it("accepts a small, highly compressible part below the ratio floor", async () => {
    const bytes = await zipOf(
      workbookParts({ "xl/styles.xml": " ".repeat(500 * 1024) }),
    );
    expect(await reasonOf(bytes)).toBe("ok");
  });

  it("refuses an empty file", async () => {
    expect(await reasonOf(new Uint8Array(0))).toBe("empty");
  });

  it("refuses a file over 30 MB before reading it", async () => {
    const big = new Uint8Array(MAX_IMPORT_BYTES + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    expect(await reasonOf(big)).toBe("too_large");
  });

  it("refuses something that is not a zip", async () => {
    const text = new TextEncoder().encode("NO.,Model No.\n76,AR-013A1\n");
    expect(await reasonOf(text)).toBe("not_zip");
  });

  it("refuses a truncated zip", async () => {
    const whole = await buildFixture();
    expect(await reasonOf(whole.subarray(0, whole.length >> 1))).toBe(
      "corrupt",
    );
  });

  it("refuses too many entries, before reading them", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_IMPORT_ENTRIES; i++) files[`f/${i}`] = "";
    const bytes = await zipOf(workbookParts(files), "STORE");
    expect(await reasonOf(bytes)).toBe("too_many_entries");
  });

  it("refuses a zip bomb by ratio (one entry inflating 1000:1)", async () => {
    const bytes = await zipOf(
      workbookParts({ "xl/media/bomb.bin": new Uint8Array(4 * 1024 * 1024) }),
    );
    expect(await reasonOf(bytes)).toBe("compression_ratio");
  });

  it("refuses a zip bomb by total declared size", async () => {
    let bytes = await zipOf(
      workbookParts({ "a.bin": "a", "b.bin": "b", "c.bin": "c" }),
      "STORE",
    );
    const each = Math.ceil(MAX_IMPORT_UNCOMPRESSED_BYTES / 3) + 1;
    for (const name of ["a.bin", "b.bin", "c.bin"]) {
      bytes = patchDeclaredSize(bytes, name, each);
    }
    expect(await reasonOf(bytes)).toBe("uncompressed_too_large");
  });

  it("refuses an entry that inflates past its declared size", async () => {
    // 2 MB of zeros declared as 20 KB: the ratio looks harmless (about 10:1)
    // but the real inflate would be 100 times what the directory promises.
    const real = await zipOf(
      workbookParts({ "xl/media/lie.bin": new Uint8Array(2 * 1024 * 1024) }),
    );
    const lying = patchDeclaredSize(real, "xl/media/lie.bin", 20 * 1024);
    expect(await reasonOf(lying)).toBe("size_mismatch");
  });

  it("refuses entries whose data overlaps (a reused-kernel bomb)", async () => {
    // Entry B's local header is hidden inside entry A's data, so B's bytes
    // are also A's bytes: per-entry caps would count them twice.
    const enc = new TextEncoder();
    const payload = enc.encode("<b/>");
    const hidden = localRecord("xl/b.xml", payload);
    const bytes = rawZip([
      { name: "[Content_Types].xml", data: enc.encode(WORKBOOK_TYPES) },
      { name: "xl/workbook.xml", data: enc.encode("<workbook/>") },
      { name: "xl/a.bin", data: hidden },
      { name: "xl/b.xml", data: payload, pointInto: { entry: 2, at: 0 } },
    ]);
    expect(await reasonOf(bytes)).toBe("overlapping_entries");
  });

  it("refuses a directory that does not end at the end record (decoy in front)", async () => {
    // Layout: decoy workbook entries + decoy directory, then a second zip's
    // entries + directory + end record that still points at the DECOY
    // directory. JSZip would shift offsets and read the second directory;
    // our check must refuse the mismatch instead.
    const decoy = await zipOf(workbookParts(), "STORE");
    const other = await zipOf(
      workbookParts({ "xl/media/x.bin": new Uint8Array(1000) }),
    );
    const decoyView = new DataView(decoy.buffer);
    const decoyEocd = decoy.length - 22;
    const decoyCdSize = decoyView.getUint32(decoyEocd + 12, true);
    const decoyCdOffset = decoyView.getUint32(decoyEocd + 16, true);
    const combined = new Uint8Array(decoyEocd + other.length);
    combined.set(decoy.subarray(0, decoyEocd));
    combined.set(other, decoyEocd);
    const view = new DataView(combined.buffer);
    const eocd = combined.length - 22;
    view.setUint16(eocd + 8, decoyView.getUint16(decoyEocd + 8, true), true);
    view.setUint16(eocd + 10, decoyView.getUint16(decoyEocd + 10, true), true);
    view.setUint32(eocd + 12, decoyCdSize, true);
    view.setUint32(eocd + 16, decoyCdOffset, true);
    expect(await reasonOf(combined)).toBe("corrupt");
  });

  it("refuses a VBA project under any part name (by content type)", async () => {
    const types = WORKBOOK_TYPES.replace(
      "</Types>",
      '<Override PartName="/xl/code.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>',
    );
    const bytes = await zipOf(
      workbookParts({
        "[Content_Types].xml": types,
        "xl/code.bin": new Uint8Array([1]),
      }),
    );
    expect(await reasonOf(bytes)).toBe("macro_enabled");
  });

  it("refuses a macro-enabled workbook (.xlsm content type)", async () => {
    const bytes = await zipOf(
      workbookParts({
        "[Content_Types].xml": WORKBOOK_TYPES.replace(
          "sheet.main+xml",
          "sheet.macroEnabled.main+xml",
        ),
      }),
    );
    expect(await reasonOf(bytes)).toBe("macro_enabled");
  });

  it("refuses a workbook carrying a VBA project, whatever its types say", async () => {
    const bytes = await zipOf(
      workbookParts({ "xl/vbaProject.bin": new Uint8Array([1, 2, 3]) }),
    );
    expect(await reasonOf(bytes)).toBe("macro_enabled");
  });

  it("refuses an undeclared VBA project in any case or folder", async () => {
    for (const name of [
      "xl/VBAPROJECT.BIN",
      "xl/VbaProject.bin",
      "xl/media/vbaProject.bin",
    ]) {
      const bytes = await zipOf(
        workbookParts({ [name]: new Uint8Array([1, 2, 3]) }),
      );
      expect(await reasonOf(bytes)).toBe("macro_enabled");
    }
  });

  it("refuses a zip without the workbook parts", async () => {
    expect(await reasonOf(await zipOf({ "readme.txt": "hi" }))).toBe(
      "not_xlsx",
    );
  });

  it("refuses a workbook part declared with another content type", async () => {
    // The sheet type appears, but not on /xl/workbook.xml.
    const types =
      '<Types><Override PartName="/xl/other.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml"/></Types>';
    const bytes = await zipOf(workbookParts({ "[Content_Types].xml": types }));
    expect(await reasonOf(bytes)).toBe("not_xlsx");
  });

  it("refuses an encrypted entry", async () => {
    const bytes = await zipOf(workbookParts(), "STORE");
    const out = new Uint8Array(bytes);
    const view = new DataView(out.buffer);
    for (let at = 0; at + 46 < out.length; at++) {
      if (view.getUint32(at, true) === 0x02014b50) {
        view.setUint16(at + 8, view.getUint16(at + 8, true) | 1, true);
      }
    }
    expect(await reasonOf(out)).toBe("unsupported_entry");
  });
});

describe("safetyWarning", () => {
  it("maps each reason to one fatal plan code with an admin message", () => {
    const expected: Record<ImportSafetyRejection, string> = {
      empty: "not_xlsx",
      too_large: "too_large",
      not_zip: "not_xlsx",
      corrupt: "not_xlsx",
      not_xlsx: "not_xlsx",
      macro_enabled: "not_xlsx",
      unsupported_entry: "not_xlsx",
      too_many_entries: "zip_unsafe",
      uncompressed_too_large: "zip_unsafe",
      compression_ratio: "zip_unsafe",
      size_mismatch: "zip_unsafe",
      overlapping_entries: "zip_unsafe",
      inconsistent_entries: "zip_unsafe",
      too_many_merged_cells: "sheet_too_complex",
      sheet_out_of_range: "not_xlsx",
    };
    for (const [reason, code] of Object.entries(expected)) {
      const warning = safetyWarning(reason as ImportSafetyRejection);
      expect(warning).toMatchObject({ code, severity: "fatal", sheet: null });
      expect(warning.detail).toBe(
        IMPORT_SAFETY_MESSAGES[reason as ImportSafetyRejection],
      );
      expect(warning.detail?.length).toBeGreaterThan(10);
    }
  });
});

/*
 * Parser differentials: our reader must see exactly the entries, names and
 * sizes JSZip (inside exceljs) will use, or a checked decoy could hide a bomb.
 */
describe("checkImportFile sees what JSZip sees", () => {
  const enc = new TextEncoder();
  const base = (): RawEntry[] => [
    { name: "[Content_Types].xml", data: enc.encode(WORKBOOK_TYPES) },
    { name: "xl/workbook.xml", data: enc.encode("<workbook/>") },
    { name: "xl/a.xml", data: enc.encode("<a/>") },
  ];

  it("accepts the hand-built baseline", async () => {
    expect(await reasonOf(rawZip(base()))).toBe("ok");
  });

  it("refuses a directory with more headers than the end record counts", async () => {
    expect(await reasonOf(rawZip(base(), { count: 2 }))).toBe("corrupt");
  });

  it("refuses a non-zero (or 0xFFFF) disk number", async () => {
    expect(await reasonOf(rawZip(base(), { diskNumber: 1 }))).toBe("corrupt");
    expect(await reasonOf(rawZip(base(), { diskNumber: 0xffff }))).toBe(
      "corrupt",
    );
  });

  it("refuses bytes after the end record that its comment does not cover", async () => {
    const trailing = new Uint8Array(30);
    expect(await reasonOf(rawZip(base(), { trailing }))).toBe("corrupt");
  });

  it("refuses a local header whose name differs from the directory's", async () => {
    const entries = base();
    entries[2] = { ...entries[2]!, localName: "xl/b.xml" };
    expect(await reasonOf(rawZip(entries))).toBe("inconsistent_entries");
  });

  it("refuses two entries with the same name (JSZip keeps the last)", async () => {
    const entries = [...base(), { name: "xl/a.xml", data: enc.encode("<b/>") }];
    expect(await reasonOf(rawZip(entries))).toBe("inconsistent_entries");
  });

  it("refuses names that differ only by a leading slash (exceljs strips it)", async () => {
    const entries = [
      ...base(),
      { name: "/xl/a.xml", data: enc.encode("<b/>") },
    ];
    expect(await reasonOf(rawZip(entries))).toBe("inconsistent_entries");
  });

  it("refuses a Unicode Path extra field (JSZip would use that name)", async () => {
    const entries = base();
    entries[2] = {
      ...entries[2]!,
      extra: extraField(0x7075, new Uint8Array([1, 0, 0, 0, 0, 0x41])),
    };
    expect(await reasonOf(rawZip(entries))).toBe("inconsistent_entries");
  });

  it("refuses zip64 sentinels on an entry (JSZip would read other sizes)", async () => {
    for (const field of [
      { compressedSize: 0xffffffff },
      { uncompressedSize: 0xffffffff },
    ]) {
      const entries = base();
      entries[2] = { ...entries[2]!, ...field };
      expect(await reasonOf(rawZip(entries))).toBe("inconsistent_entries");
    }
  });

  it("accepts a zip64 extra field when no field is a sentinel", async () => {
    const entries = base();
    entries[2] = {
      ...entries[2]!,
      extra: extraField(0x0001, new Uint8Array(8)),
    };
    expect(await reasonOf(rawZip(entries))).toBe("ok");
  });

  it("refuses a name that is not valid UTF-8", async () => {
    const zip = rawZip(base());
    // Patch one byte of "xl/a.xml" (central + local) to 0xFF.
    const out = new Uint8Array(zip);
    for (let i = 0; i + 8 <= out.length; i++) {
      if (new TextDecoder().decode(out.subarray(i, i + 8)) === "xl/a.xml") {
        out[i + 3] = 0xff;
      }
    }
    expect(await reasonOf(out)).toBe("inconsistent_entries");
  });
});

describe("checkImportFile range guard (gate A M-1)", () => {
  const sheetPart = "xl/worksheets/sheet1.xml";

  async function checkedBytes(bytes: Uint8Array): Promise<Uint8Array> {
    return (await checked(bytes)).bytes;
  }

  it("hands on every part unchanged when nothing needs guarding", async () => {
    const original = await buildFixture();
    expect(digestsOf(await checkedBytes(original))).toEqual(
      digestsOf(original),
    );
  });

  it("gives a file that passes the check again, unchanged (a fixed point)", async () => {
    const plain = await buildFixture({ merged: true });
    // One file the guard leaves alone, one it has to strip.
    const stripped = await patchZip(plain, {
      [sheetPart]: (xml) =>
        xml.replace(
          "</sheetData>",
          '</sheetData><dataValidations count="1"><dataValidation sqref="C3:C1048576"/></dataValidations>',
        ),
      "xl/workbook.xml": (xml) =>
        xml.replace(
          "</sheets>",
          '</sheets><definedNames><definedName name="x">Sheet1!$A:$A</definedName></definedNames>',
        ),
    });
    for (const upload of [plain, stripped]) {
      const once = await checkedBytes(upload);
      expect(Buffer.compare(await checkedBytes(once), once)).toBe(0);
    }
  });

  it("strips honest whole-column dropdowns and print areas; rows read the same, fast", async () => {
    const plain = await buildFixture();
    const columns = ["C", "D", "E", "F", "G", "H", "I", "J"];
    const validations = columns
      .map(
        (c) =>
          `<dataValidation type="list" allowBlank="1" sqref="${c}3:${c}1048576"><formula1>"a,b"</formula1></dataValidation>`,
      )
      .join("");
    const bytes = await patchZip(plain, {
      [sheetPart]: (xml) =>
        xml.replace(
          /<pageMargins/,
          `<dataValidations count="${columns.length}">${validations}</dataValidations><pageMargins`,
        ),
      "xl/workbook.xml": (xml) =>
        xml.replace(
          "</sheets>",
          '</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Sheet1!$A:$AG</definedName></definedNames>',
        ),
    });
    // The payload really is in the upload (a missed anchor would make the
    // "stripped" assertions below pass vacuously).
    const injected = partsOf(bytes);
    const decode = (data: Uint8Array | undefined) =>
      new TextDecoder().decode(data ?? new Uint8Array());
    expect(decode(injected.get(sheetPart))).toContain("<dataValidations");
    expect(decode(injected.get("xl/workbook.xml"))).toContain("<definedNames");

    const checkedFile = await checkedBytes(bytes);
    const guarded = partsOf(checkedFile);
    const guardedDigests = digestsOf(checkedFile);
    const original = digestsOf(plain);
    // Only the two guarded parts differ from the plain fixture, and only by
    // the stripped elements.
    for (const [name, digest] of original) {
      if (name === sheetPart || name === "xl/workbook.xml") continue;
      expect(guardedDigests.get(name), name).toBe(digest);
    }
    const text = (name: string) =>
      new TextDecoder().decode(guarded.get(name) ?? new Uint8Array());
    expect(text(sheetPart)).not.toContain("dataValidation");
    expect(text("xl/workbook.xml")).not.toContain("definedName");

    const start = performance.now();
    const read = await readWorkbook(await checked(bytes));
    expect(performance.now() - start).toBeLessThan(2_000);
    const reference = await readWorkbook(await checked(plain));
    if (!read.ok || !reference.ok) throw new Error("expected both to read");
    expect(read.rows).toEqual(reference.rows);
  });

  it("writes a standard zip: declared CRCs match, JSZip reads it with CRC checks", async () => {
    const bytes = await patchZip(await buildFixture(), {
      [sheetPart]: (xml) =>
        xml.replace("</sheetData>", '</sheetData><dataValidations count="0"/>'),
    });
    const rebuilt = await checkedBytes(bytes);
    const directory = readCentralDirectory(rebuilt, {
      maxEntries: 10_000,
      trailer: "none",
    });
    if (!directory.ok) throw new Error(directory.reason);
    const parts = partsOf(rebuilt);
    for (const entry of directory.entries) {
      expect(entry.crc32, entry.name).toBe(
        crc32(parts.get(entry.name) ?? new Uint8Array()),
      );
    }
    const zip = await JSZip.loadAsync(rebuilt, { checkCRC32: true });
    expect(await zip.file(sheetPart)?.async("string")).not.toContain(
      "dataValidations",
    );
  });

  it("refuses too many merged ranges, with an admin message", async () => {
    const merges = Array.from(
      { length: MAX_IMPORT_MERGES + 1 },
      (_, i) => `<mergeCell ref="AH${20 + 2 * i}:AH${21 + 2 * i}"/>`,
    ).join("");
    const bytes = await patchZip(await buildFixture(), {
      [sheetPart]: (xml) =>
        xml.replace(
          "</sheetData>",
          `</sheetData><mergeCells>${merges}</mergeCells>`,
        ),
    });
    expect(await reasonOf(bytes)).toBe("too_many_merged_cells");
    expect(safetyWarning("too_many_merged_cells")).toMatchObject({
      code: "sheet_too_complex",
      severity: "fatal",
    });
  });

  it("refuses a column range past XFD and a huge sheet id", async () => {
    const base = await buildFixture();
    const wideColumns = await patchZip(base, {
      [sheetPart]: (xml) =>
        xml.replace(
          "<sheetData>",
          '<cols><col min="40" max="10000000" width="3"/></cols><sheetData>',
        ),
    });
    expect(await reasonOf(wideColumns)).toBe("sheet_out_of_range");
    const bigId = await patchZip(base, {
      "xl/workbook.xml": (xml) =>
        xml.replace(/sheetId="1"/, 'sheetId="200000000"'),
    });
    expect(await reasonOf(bigId)).toBe("sheet_out_of_range");
  });

  it("guards every part exceljs would read as a worksheet, not just sheet1", async () => {
    // exceljs's worksheet pattern is not anchored, so this part is parsed.
    const bytes = await patchZip(await buildFixture(), {
      "decoy/xl/worksheets/sheet7.xml":
        '<worksheet><sheetData/><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>',
    });
    expect(await reasonOf(bytes)).toBe("too_many_merged_cells");
  });

  it("refuses a guarded part that is not UTF-8", async () => {
    const bytes = await patchZip(await buildFixture(), {
      [sheetPart]: new Uint8Array([0xff, 0xfe, 0x3c, 0x00]),
    });
    expect(await reasonOf(bytes)).toBe("corrupt");
  });
});
