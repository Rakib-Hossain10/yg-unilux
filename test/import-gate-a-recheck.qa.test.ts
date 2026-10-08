// Phase 3 QA gate A re-checks (fixes in 620711c and 09d7c23): attacks on the
// sheet guard (parser differences against exceljs/saxes), the part-name rule
// (JSZip resolves names on load), the zip rewriter, the CheckedImportFile
// brand, and regressions (datasheet check, real sheet). Assertions inspect
// the guard's output or the exact refusal reason; load time is only a
// backstop with a wide margin.

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { MAX_IMPORT_MERGED_CELLS } from "@/lib/constants";
import { readEmbeddedImages } from "@/lib/import/images";
import {
  checkImportFile,
  type CheckedImportFile,
  type ImportSafetyRejection,
} from "@/lib/import/safety";
import { readWorkbook } from "@/lib/import/workbook";
import { checkXlsx } from "@/lib/xlsx-signature";

import { buildFixture } from "./fixtures/import/build";
import { digestsOf } from "./fixtures/import/checked";
import { patchZip, type PartEdit } from "./fixtures/import/patch-zip";
import { rawZip } from "./fixtures/import/raw-zip";

const SHEET = "xl/worksheets/sheet1.xml";
const NEWLINE = String.fromCharCode(10);
const BOM = String.fromCharCode(0xfeff);
const BACKSLASH = String.fromCharCode(92);

/* ~1.6M covered cells: far over the 100,000 cap; exceljs needs seconds. */
const BIG = "C3:XFD100";
/* 220,000 cells: over the cap, yet cheap for exceljs if it ever got through. */
const OVER_CAP = "AH20:AH220020";

const afterSheetData = (fragment: string) => (xml: string) =>
  xml.replace("</sheetData>", `</sheetData>${fragment}`);
const mergeOf = (ref: string) =>
  `<mergeCells count="1"><mergeCell ref="${ref}"/></mergeCells>`;

type Outcome =
  { refused: ImportSafetyRejection } | { accepted: CheckedImportFile };

async function outcomeOf(bytes: Uint8Array): Promise<Outcome> {
  const result = await checkImportFile(bytes);
  return result.ok ? { accepted: result.file } : { refused: result.reason };
}

async function patched(edits: Record<string, PartEdit>): Promise<Outcome> {
  return outcomeOf(await patchZip(await buildFixture(), edits));
}

function reasonOf(outcome: Outcome): ImportSafetyRejection | "accepted" {
  return "refused" in outcome ? outcome.refused : "accepted";
}

/* "A" → 1, "XFD" → 16384; NaN for anything that is not letters. */
function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0) - 64;
    if (code < 1 || code > 26) return Number.NaN;
    n = n * 26 + code;
  }
  return n;
}

/* Cells of an "A1" / "A1:B2" ref; Infinity when it is not a plain ref. */
function areaOf(ref: string): number {
  const corners = ref.replaceAll("$", "").split(":");
  const cells = corners.map((corner) => {
    let i = 0;
    while (i < corner.length && /[A-Za-z]/.test(corner.charAt(i))) i++;
    const digits = corner.slice(i);
    return {
      col: columnNumber(corner.slice(0, i)),
      row: /^[0-9]+$/.test(digits) ? Number(digits) : Number.NaN,
    };
  });
  const [a, b = a] = cells;
  if (!a || !b || corners.length > 2) return Number.POSITIVE_INFINITY;
  const area = (Math.abs(b.row - a.row) + 1) * (Math.abs(b.col - a.col) + 1);
  return Number.isFinite(area) ? area : Number.POSITIVE_INFINITY;
}

/* Total cells covered by every <mergeCell> (any prefix) in one part. */
function mergedCellsIn(xml: string): number {
  let total = 0;
  let at = xml.indexOf("mergeCell");
  while (at !== -1) {
    const next = xml.charAt(at + "mergeCell".length);
    const tagEnd = xml.indexOf(">", at);
    if (next !== "s" && xml.charAt(at - 1) !== "/" && tagEnd !== -1) {
      const tag = xml.slice(at, tagEnd);
      const ref = /(?:^|[^:\w])ref\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
      if (ref) total += areaOf(ref[1] ?? ref[2] ?? "");
    }
    at = xml.indexOf("mergeCell", at + 1);
  }
  return total;
}

/*
 * What the guard handed on is bounded: no <dataValidations> or
 * <definedNames> element left in any part exceljs reads as the workbook or
 * a worksheet, and merges within the cap.
 */
async function expectBounded(file: CheckedImportFile): Promise<void> {
  const zip = await JSZip.loadAsync(file.bytes);
  for (const entry of Object.values(zip.files)) {
    const name = entry.name.toLowerCase();
    if (entry.dir) continue;
    if (name !== "xl/workbook.xml" && !name.includes("xl/worksheets/sheet")) {
      continue;
    }
    const xml = await entry.async("string");
    expect(xml).not.toMatch(/<(?:\w+:)?dataValidations[\s/>]/);
    expect(xml).not.toMatch(/<(?:\w+:)?definedNames[\s/>]/);
    expect(mergedCellsIn(xml)).toBeLessThanOrEqual(MAX_IMPORT_MERGED_CELLS);
  }
}

describe("gate A re-check: sheet guard vs exceljs", () => {
  it("counts namespaced, single-quoted, spaced and decoy-attribute merge refs", async () => {
    for (const merge of [
      `<x:mergeCells count="1"><x:mergeCell ref="${BIG}"/></x:mergeCells>`,
      `<mergeCells count="1"><mergeCell ref='${BIG}'/></mergeCells>`,
      `<mergeCells count="1"><mergeCell   ref = "${BIG}"  /></mergeCells>`,
      `<mergeCells count="1"><mergeCell${NEWLINE}ref="${BIG}"></mergeCell></mergeCells>`,
      `<mergeCells count="1"><mergeCell r:ref="A1" ref="${BIG}"/></mergeCells>`,
    ]) {
      const outcome = await patched({ [SHEET]: afterSheetData(merge) });
      expect(reasonOf(outcome)).toBe("too_many_merged_cells");
    }
  }, 60_000);

  it("refuses entity-encoded or padded refs instead of reading a smaller range", async () => {
    for (const ref of [
      "C3&#58;XFD100",
      " C3:XFD100",
      "C3:XFD1&#48;0",
      "C3:XFD100 ",
    ]) {
      const outcome = await patched({ [SHEET]: afterSheetData(mergeOf(ref)) });
      expect(reasonOf(outcome)).toBe("sheet_out_of_range");
    }
  }, 60_000);

  it("leaves no <dataValidations> element when a close tag hides in a comment or CDATA", async () => {
    const dv = `<dataValidation type="whole" sqref="${BIG}"><formula1>1</formula1></dataValidation>`;
    for (const block of [
      `<dataValidations count="1"><!-- </dataValidations> -->${dv}</dataValidations>`,
      `<dataValidations count="1"><!-- </dataValidations><dataValidations> -->${dv}</dataValidations>`,
      `<dataValidations count="1">${dv}<![CDATA[</dataValidations>]]></dataValidations>`,
      `<dataValidations count="1">${dv}</dataValidations  >`,
    ]) {
      const outcome = await patched({
        [SHEET]: (xml) => xml.replace(/<pageMargins/, `${block}<pageMargins`),
      });
      if ("accepted" in outcome) await expectBounded(outcome.accepted);
      else expect(outcome.refused).toBe("corrupt");
    }
  }, 60_000);

  it("guards a merge in a UTF-8-BOM part", async () => {
    const outcome = await patched({
      [SHEET]: (xml) => BOM + afterSheetData(mergeOf(BIG))(xml),
    });
    expect(reasonOf(outcome)).toBe("too_many_merged_cells");
  }, 60_000);

  it("a UTF-16 worksheet never reaches exceljs as a readable sheet", async () => {
    const original = await new JSZip()
      .loadAsync(await buildFixture())
      .then((z) => z.file(SHEET)?.async("string"));
    const text = afterSheetData(mergeOf(BIG))(
      (original ?? "").replace('encoding="UTF-8"', 'encoding="UTF-16"'),
    );
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      utf16[2 + 2 * i] = c & 0xff;
      utf16[3 + 2 * i] = c >> 8;
    }
    const outcome = await patched({ [SHEET]: utf16 });
    if ("refused" in outcome) return;
    // Accepted: exceljs decodes parts as UTF-8 and saxes refuses the NULs.
    const read = await readWorkbook(outcome.accepted);
    expect(read.ok).toBe(false);
  }, 60_000);

  it("guards every part exceljs reads as a worksheet (its pattern is unanchored)", async () => {
    const original = await new JSZip()
      .loadAsync(await buildFixture())
      .then((z) => z.file(SHEET)?.async("string"));
    const evil = afterSheetData(mergeOf(BIG))(original ?? "");
    for (const name of [
      "zz/xl/worksheets/sheet7.xml",
      "xl/worksheets/sheet8.xml.bak",
      "xl/worksheets/sheet10.xmlx",
    ]) {
      expect([name, reasonOf(await patched({ [name]: evil }))]).toEqual([
        name,
        "too_many_merged_cells",
      ]);
    }
    // A case variant: JSZip adds the folders "XL/" and "XL/Worksheets/",
    // which collide with "xl/" without case, so the duplicate rule would
    // refuse it first; written raw (no folders) the guard must refuse it.
    // Same for a non-ASCII name (JSZip would add a Unicode Path extra field,
    // which the identity rule refuses).
    for (const name of [
      "XL/Worksheets/Sheet9.XML",
      `xl/worksheets/sheet11.xml${String.fromCharCode(0x301)}`,
    ]) {
      const raw = await rawOutcome((parts) => [
        ...parts,
        [name, bytesOf(evil)],
      ]);
      expect([name, reasonOf(raw)]).toEqual([name, "too_many_merged_cells"]);
    }
  }, 60_000);

  it("keeps 2,000 small merges (bounded output; load time only a backstop)", async () => {
    const merges: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const r = 20 + i;
      merges.push(`<mergeCell ref="AH${r}:AI${r}"/>`);
    }
    const outcome = await patched({
      [SHEET]: afterSheetData(
        `<mergeCells count="2000">${merges.join("")}</mergeCells>`,
      ),
    });
    if (!("accepted" in outcome)) throw new Error(reasonOf(outcome));
    await expectBounded(outcome.accepted);
    const start = performance.now();
    expect((await readWorkbook(outcome.accepted)).ok).toBe(true);
    expect(performance.now() - start).toBeLessThan(30_000);
  }, 60_000);

  it("refuses 2,001 merges and a single merge over 100,000 cells", async () => {
    const merges: string[] = [];
    for (let i = 0; i < 2001; i++) {
      merges.push(`<mergeCell ref="AH${20 + i}"/>`);
    }
    const many = await patched({
      [SHEET]: afterSheetData(`<mergeCells>${merges.join("")}</mergeCells>`),
    });
    expect(reasonOf(many)).toBe("too_many_merged_cells");
    const large = await patched({
      [SHEET]: afterSheetData(mergeOf("AH20:AH100020")),
    });
    expect(reasonOf(large)).toBe("too_many_merged_cells");
  }, 60_000);

  it("refuses <col max> past XFD and a huge sheetId", async () => {
    const cols = await patched({
      [SHEET]: (xml) =>
        xml.replace(
          /<sheetData/,
          '<cols><col min="1" max="99999999" width="9"/></cols><sheetData',
        ),
    });
    expect(reasonOf(cols)).toBe("sheet_out_of_range");
    const sheetId = await patched({
      "xl/workbook.xml": (xml) =>
        xml.replace(/sheetId="1"/, 'sheetId="99999999"'),
    });
    expect(reasonOf(sheetId)).toBe("sheet_out_of_range");
  }, 60_000);
});

describe("gate A re-check: zip rewrite", () => {
  it("rewrites a zip that re-passes every check, CRCs verified, parts unchanged", async () => {
    const original = await buildFixture();
    const result = await checkImportFile(original);
    if (!result.ok) throw new Error(result.reason);
    const rebuilt = result.file.bytes;
    // JSZip with CRC checking: every rewritten and copied CRC is right.
    const zip = await JSZip.loadAsync(rebuilt, { checkCRC32: true });
    for (const file of Object.values(zip.files)) {
      if (!file.dir) await file.async("uint8array");
    }
    expect(digestsOf(rebuilt)).toEqual(digestsOf(original));
    const again = await checkImportFile(rebuilt);
    expect(again.ok && digestsOf(again.file.bytes)).toEqual(
      digestsOf(original),
    );
  });

  it("drops only the stripped elements and keeps every CRC right after a rewrite", async () => {
    const bytes = await patchZip(await buildFixture(), {
      [SHEET]: (xml) =>
        xml.replace(
          /<pageMargins/,
          '<dataValidations count="1"><dataValidation type="list" sqref="C3:C1048576"><formula1>"a,b"</formula1></dataValidation></dataValidations><pageMargins',
        ),
    });
    const result = await checkImportFile(bytes);
    if (!result.ok) throw new Error(result.reason);
    const zip = await JSZip.loadAsync(result.file.bytes, { checkCRC32: true });
    const sheet = (await zip.file(SHEET)?.async("string")) ?? "";
    expect(sheet).not.toContain("dataValidation");
    expect(sheet).toContain("<sheetData");
    const before = digestsOf(bytes);
    const after = digestsOf(result.file.bytes);
    for (const [name, digest] of before) {
      if (name !== SHEET) expect(after.get(name)).toBe(digest);
    }
  });

  it("the readers refuse raw bytes and look-alike objects", async () => {
    const bytes = await buildFixture();
    await expect(
      readWorkbook({ bytes } as unknown as Parameters<typeof readWorkbook>[0]),
    ).rejects.toThrow(TypeError);
    await expect(
      readEmbeddedImages(
        bytes as unknown as Parameters<typeof readEmbeddedImages>[0],
        ["Sheet1"],
      ),
    ).rejects.toThrow(TypeError);
  });

  it("the datasheet check is unaffected (fixture and exceljs workbook accepted)", async () => {
    expect(await checkXlsx(await buildFixture())).toEqual({ ok: true });
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRow(["a"]);
    expect(
      await checkXlsx(new Uint8Array(await wb.xlsx.writeBuffer())),
    ).toEqual({ ok: true });
  });
});

/*
 * JSZip (inside exceljs) RESOLVES entry names on load (jszip/lib/load.js:66,
 * utils.resolve): "." and empty segments are dropped, ".." pops a segment,
 * and a later entry with the same resolved name replaces an earlier one.
 * patchZip goes through JSZip (which resolves on add), so these files are
 * written with the raw zip writer.
 */
async function fixtureParts(): Promise<[string, Uint8Array][]> {
  const zip = await JSZip.loadAsync(await buildFixture());
  const parts: [string, Uint8Array][] = [];
  for (const file of Object.values(zip.files)) {
    if (!file.dir) parts.push([file.name, await file.async("uint8array")]);
  }
  return parts;
}

const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);
const bytesOf = (s: string) => new TextEncoder().encode(s);

async function rawOutcome(
  edit: (parts: [string, Uint8Array][]) => [string, Uint8Array][],
): Promise<Outcome> {
  const parts = edit(await fixtureParts());
  return outcomeOf(rawZip(parts.map(([name, data]) => ({ name, data }))));
}

/* The fixture with sheet1 renamed and carrying a merge over the cap. */
const renamedSheet =
  (name: string) =>
  (parts: [string, Uint8Array][]): [string, Uint8Array][] =>
    parts.map(([n, data]): [string, Uint8Array] =>
      n === SHEET
        ? [name, bytesOf(afterSheetData(mergeOf(OVER_CAP))(text(data)))]
        : [n, data],
    );

describe("gate A re-check: entry names JSZip resolves (M-3)", () => {
  it("baseline: the raw-written stored fixture is accepted and bounded", async () => {
    const outcome = await rawOutcome((parts) => parts);
    if (!("accepted" in outcome)) throw new Error(reasonOf(outcome));
    await expectBounded(outcome.accepted);
    expect((await readWorkbook(outcome.accepted)).ok).toBe(true);
  }, 60_000);

  it("refuses every name JSZip would resolve to another name, and backslashes", async () => {
    for (const name of [
      "xl/./worksheets/sheet1.xml",
      "./xl/worksheets/sheet1.xml",
      "xl//worksheets/sheet1.xml",
      "//xl/worksheets/sheet1.xml",
      "xl/a/../worksheets/sheet1.xml",
      "xl/worksheets/sheet1.xml/..",
      `xl${BACKSLASH}worksheets${BACKSLASH}sheet1.xml`,
    ]) {
      const outcome = await rawOutcome(renamedSheet(name));
      expect([name, reasonOf(outcome)]).toEqual([name, "inconsistent_entries"]);
    }
  }, 60_000);

  it("refuses a second workbook part that resolves onto xl/workbook.xml", async () => {
    const outcome = await rawOutcome((parts) => {
      const workbook = text(parts.find(([n]) => n === "xl/workbook.xml")?.[1]);
      const evil = workbook.replace(
        "</sheets>",
        '</sheets><definedNames><definedName name="x">Sheet1!$A$1:$B$2</definedName></definedNames>',
      );
      return [...parts, ["xl/a/../workbook.xml", bytesOf(evil)]];
    });
    expect(reasonOf(outcome)).toBe("inconsistent_entries");
  }, 60_000);

  it("refuses names that collide after dropping one leading '/' or ignoring case", async () => {
    for (const twin of [
      "/xl/worksheets/sheet1.xml",
      "XL/Worksheets/Sheet1.xml",
    ]) {
      const outcome = await rawOutcome((parts) => {
        const sheet = parts.find(([n]) => n === SHEET)?.[1] ?? new Uint8Array();
        return [
          ...parts,
          [twin, bytesOf(afterSheetData(mergeOf(OVER_CAP))(text(sheet)))],
        ];
      });
      expect(reasonOf(outcome)).toBe("inconsistent_entries");
    }
  }, 60_000);

  it("a single leading '/' is accepted and still guarded", async () => {
    const outcome = await rawOutcome(renamedSheet("/xl/worksheets/sheet1.xml"));
    expect(reasonOf(outcome)).toBe("too_many_merged_cells");
  }, 60_000);

  it("a percent-encoded or trailing-dot name never reaches exceljs as an unguarded sheet", async () => {
    for (const name of [
      "xl/worksheets/sheet%31.xml",
      "xl/worksheets/sheet1.xml.",
      "xl/worksheets/sheet1.xml ",
    ]) {
      const outcome = await rawOutcome((parts) => [
        ...parts,
        ...renamedSheet(name)([
          [SHEET, parts.find(([n]) => n === SHEET)?.[1] ?? new Uint8Array()],
        ]),
      ]);
      if ("refused" in outcome) {
        expect(outcome.refused).toBe("too_many_merged_cells");
        continue;
      }
      // Accepted: exceljs must not hold the over-cap merge anywhere.
      const read = await readWorkbook(outcome.accepted);
      if (!read.ok) continue;
      for (const ws of read.workbook.worksheets) {
        const merges = (ws as unknown as { _merges: Record<string, unknown> })
          ._merges;
        expect(Object.keys(merges)).toHaveLength(0);
      }
    }
  }, 60_000);
});

describe("gate A re-check: pictures and rows come from one part (I-7)", () => {
  it("skips a sheet's pictures when exceljs would splice its target to another path", async () => {
    // exceljs: `xl/${" /xl/worksheets/sheet1.xml".replace(/^(\s|\/xl\/)+/, "")}`
    // = xl/worksheets/sheet1.xml; resolveTarget reads " " as a relative
    // segment. The two differ, so the pictures must not be read at all.
    const bytes = await patchZip(await buildFixture(), {
      "xl/_rels/workbook.xml.rels": (xml) =>
        xml.replace(
          'Target="worksheets/sheet1.xml"',
          'Target=" /xl/worksheets/sheet1.xml"',
        ),
    });
    const outcome = await outcomeOf(bytes);
    if (!("accepted" in outcome)) throw new Error(reasonOf(outcome));
    const read = await readWorkbook(outcome.accepted);
    if (!read.ok) return;
    const embedded = await readEmbeddedImages(
      outcome.accepted,
      read.sheets.map((s) => s.name),
    );
    expect(embedded.anchors).toEqual([]);
    expect(embedded.warnings.map((w) => w.code)).toContain(
      "unsupported_image_store",
    );
  }, 60_000);

  it("refuses two sheets with one name (exceljs throws), so rows cannot cross sheets", async () => {
    const bytes = await patchZip(await buildFixture({ secondSheet: true }), {
      "xl/workbook.xml": (xml) => xml.replace('name="Sheet2"', 'name="Sheet1"'),
    });
    const outcome = await outcomeOf(bytes);
    if (!("accepted" in outcome)) return;
    expect((await readWorkbook(outcome.accepted)).ok).toBe(false);
  }, 60_000);
});

const REAL_SHEET =
  // eslint-disable-next-line no-restricted-properties
  process.env.IMPORT_FIXTURE ?? "doc/reference/client-sample-sheet.xlsx";

describe("gate A re-check: real client sheet (local only, never committed)", () => {
  it("is rewritten without changing any part but the guarded ones, and reads the same rows", async (ctx) => {
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(REAL_SHEET)) {
      console.warn(
        `[gate A re-check] real sheet missing at ${REAL_SHEET}: skipped`,
      );
      ctx.skip();
      return;
    }
    const original = new Uint8Array(readFileSync(REAL_SHEET));
    const result = await checkImportFile(original);
    if (!result.ok) throw new Error(result.reason);
    const before = digestsOf(original);
    const after = digestsOf(result.file.bytes);
    expect([...after.keys()]).toEqual([...before.keys()]);
    const changed = [...before]
      .filter(([n, d]) => after.get(n) !== d)
      .map(([n]) => n);
    for (const name of changed) {
      expect(
        name === "xl/workbook.xml" || name.includes("xl/worksheets/sheet"),
      ).toBe(true);
    }
    const direct = new ExcelJS.Workbook();
    // exceljs types predate the generic Buffer (same cast as workbook.ts).
    await direct.xlsx.load(Buffer.from(original) as unknown as ExcelJS.Buffer);
    const read = await readWorkbook(result.file);
    if (!read.ok) throw new Error("unreadable");
    const directRows: string[] = [];
    direct.worksheets[0]?.eachRow((row, r) => {
      if (r > (read.sheets[0]?.headerRow ?? 1)) directRows.push(String(r));
    });
    expect(read.rows.map((r) => String(r.row))).toEqual(directRows);
  }, 60_000);
});
