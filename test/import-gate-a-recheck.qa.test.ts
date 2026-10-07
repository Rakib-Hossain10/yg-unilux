// Phase 3 QA gate A re-check (fixes in 620711c): attacks on the sheet guard
// (parser differences against exceljs/saxes), the zip rewriter, the
// CheckedImportFile brand, and regressions (datasheet check, real sheet).
// `it.fails` = a confirmed defect.

import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { readEmbeddedImages } from "@/lib/import/images";
import { checkImportFile } from "@/lib/import/safety";
import { readWorkbook } from "@/lib/import/workbook";
import { checkXlsx } from "@/lib/xlsx-signature";

import { buildFixture } from "./fixtures/import/build";
import { digestsOf } from "./fixtures/import/checked";
import { patchZip, type PartEdit } from "./fixtures/import/patch-zip";
import { rawZip } from "./fixtures/import/raw-zip";

const SHEET = "xl/worksheets/sheet1.xml";

/* ~1.6M covered cells: exceljs needs ~5 s for this; bounded, not a hang. */
const BIG = "C3:XFD100";

const afterSheetData = (fragment: string) => (xml: string) =>
  xml.replace("</sheetData>", `</sheetData>${fragment}`);

/*
 * The property every attack must respect: the file is refused, or exceljs
 * reads the checked bytes quickly (the range never reached it in full).
 */
async function refusedOrFast(
  edits: Record<string, PartEdit>,
): Promise<"refused" | number> {
  const bytes = await patchZip(await buildFixture(), edits);
  const result = await checkImportFile(bytes);
  if (!result.ok) return "refused";
  const start = performance.now();
  await readWorkbook(result.file);
  return performance.now() - start;
}

function expectSafe(outcome: "refused" | number) {
  if (outcome !== "refused") expect(outcome).toBeLessThan(2000);
}

describe("gate A re-check: sheet guard vs exceljs", () => {
  it("refuses a namespaced, single-quoted or spaced merge ref (superset of exceljs)", async () => {
    for (const merge of [
      `<x:mergeCells count="1"><x:mergeCell ref="${BIG}"/></x:mergeCells>`,
      `<mergeCells count="1"><mergeCell ref='${BIG}'/></mergeCells>`,
      `<mergeCells count="1"><mergeCell   ref = "${BIG}"  /></mergeCells>`,
      `<mergeCells count="1"><mergeCell\nref="${BIG}"></mergeCell></mergeCells>`,
      `<mergeCells count="1"><mergeCell r:ref="A1" ref="${BIG}"/></mergeCells>`,
    ]) {
      const outcome = await refusedOrFast({ [SHEET]: afterSheetData(merge) });
      expect(outcome).toBe("refused");
    }
  }, 60_000);

  it("refuses entity-encoded or padded refs instead of reading a smaller range", async () => {
    for (const ref of [
      "C3&#58;XFD100",
      " C3:XFD100",
      "C3:XFD1&#48;0",
      "C3:XFD100 ",
    ]) {
      const outcome = await refusedOrFast({
        [SHEET]: afterSheetData(
          `<mergeCells count="1"><mergeCell ref="${ref}"/></mergeCells>`,
        ),
      });
      expectSafe(outcome);
    }
  }, 60_000);

  it("is not fooled by a close tag inside a comment or CDATA within dataValidations", async () => {
    const dv = `<dataValidation type="whole" sqref="${BIG}"><formula1>1</formula1></dataValidation>`;
    for (const block of [
      `<dataValidations count="1"><!-- </dataValidations> -->${dv}</dataValidations>`,
      `<dataValidations count="1"><!-- </dataValidations><dataValidations> -->${dv}</dataValidations>`,
      `<dataValidations count="1">${dv}<![CDATA[</dataValidations>]]></dataValidations>`,
      `<dataValidations count="1">${dv}</dataValidations  >`,
    ]) {
      const outcome = await refusedOrFast({
        [SHEET]: (xml) => xml.replace(/<pageMargins/, `${block}<pageMargins`),
      });
      expectSafe(outcome);
    }
  }, 60_000);

  it("guards a merge in a UTF-8-BOM part and refuses a UTF-16 part", async () => {
    const merge = `<mergeCells count="1"><mergeCell ref="${BIG}"/></mergeCells>`;
    const bom = await refusedOrFast({
      [SHEET]: (xml) => "﻿" + afterSheetData(merge)(xml),
    });
    expect(bom).toBe("refused");
    const original = await new JSZip()
      .loadAsync(await buildFixture())
      .then((z) => z.file(SHEET)?.async("string"));
    const text = afterSheetData(merge)(
      (original ?? "").replace('encoding="UTF-8"', 'encoding="UTF-16"'),
    );
    const utf16 = new Uint8Array(2 + text.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      utf16[2 + 2 * i] = c & 0xff;
      utf16[3 + 2 * i] = c >> 8;
    }
    expectSafe(await refusedOrFast({ [SHEET]: utf16 }));
  }, 60_000);

  it("guards every part exceljs reads as a worksheet (its pattern is unanchored)", async () => {
    const original = await new JSZip()
      .loadAsync(await buildFixture())
      .then((z) => z.file(SHEET)?.async("string"));
    const evil = afterSheetData(
      `<mergeCells count="1"><mergeCell ref="${BIG}"/></mergeCells>`,
    )(original ?? "");
    for (const name of [
      "zz/xl/worksheets/sheet7.xml",
      "xl/worksheets/sheet8.xml.bak",
      "XL/Worksheets/Sheet9.XML",
      "xl/worksheets/sheet10.xmlx",
    ]) {
      expectSafe(await refusedOrFast({ [name]: evil }));
    }
  }, 60_000);

  it("allows 2,000 small merges and exceljs still loads them fast (O(n^2) check)", async () => {
    const merges: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const r = 20 + i;
      merges.push(`<mergeCell ref="AH${r}:AI${r}"/>`);
    }
    const outcome = await refusedOrFast({
      [SHEET]: afterSheetData(
        `<mergeCells count="2000">${merges.join("")}</mergeCells>`,
      ),
    });
    expect(outcome).not.toBe("refused");
    expect(outcome).toBeLessThan(5000);
  }, 60_000);

  it("refuses 2,001 merges and a single merge over 100,000 cells", async () => {
    const merges: string[] = [];
    for (let i = 0; i < 2001; i++)
      merges.push(`<mergeCell ref="AH${20 + i}"/>`);
    expect(
      await refusedOrFast({
        [SHEET]: afterSheetData(`<mergeCells>${merges.join("")}</mergeCells>`),
      }),
    ).toBe("refused");
    expect(
      await refusedOrFast({
        [SHEET]: afterSheetData(
          '<mergeCells><mergeCell ref="AH20:AH100020"/></mergeCells>',
        ),
      }),
    ).toBe("refused");
  }, 60_000);

  it("refuses <col max> past XFD and a huge sheetId", async () => {
    expect(
      await refusedOrFast({
        [SHEET]: (xml) =>
          xml.replace(
            /<sheetData/,
            '<cols><col min="1" max="99999999" width="9"/></cols><sheetData',
          ),
      }),
    ).toBe("refused");
    expect(
      await refusedOrFast({
        "xl/workbook.xml": (xml) =>
          xml.replace(/sheetId="1"/, 'sheetId="99999999"'),
      }),
    ).toBe("refused");
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
 * utils.resolve): "." and empty segments are dropped and ".." pops a
 * segment, and a later entry with the same resolved name replaces an
 * earlier one. safety.ts and the sheet guard work on the RAW names, so
 * "xl/./worksheets/sheet1.xml" is not guarded (WORKSHEET_PART does not
 * match it) yet exceljs reads it as xl/worksheets/sheet1.xml, and
 * "xl/a/../workbook.xml" placed after the real workbook passes the
 * duplicate check yet replaces it inside exceljs.
 */
async function rawFixture(
  edit: (parts: Map<string, Uint8Array>) => [string, Uint8Array][],
): Promise<Uint8Array> {
  const parts = new Map<string, Uint8Array>();
  const zip = await JSZip.loadAsync(await buildFixture());
  for (const file of Object.values(zip.files)) {
    if (!file.dir) parts.set(file.name, await file.async("uint8array"));
  }
  return rawZip(edit(parts).map(([name, data]) => ({ name, data })));
}

const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);
const bytesOf = (s: string) => new TextEncoder().encode(s);

async function safeOutcome(bytes: Uint8Array): Promise<"refused" | number> {
  const result = await checkImportFile(bytes);
  if (!result.ok) return "refused";
  const start = performance.now();
  await readWorkbook(result.file);
  return performance.now() - start;
}

describe("gate A re-check: entry names JSZip resolves", () => {
  it("baseline: the hand-rebuilt stored fixture is accepted and reads fast", async () => {
    const bytes = await rawFixture((parts) => [...parts]);
    const outcome = await safeOutcome(bytes);
    expect(outcome).not.toBe("refused");
    expect(outcome).toBeLessThan(2000);
  }, 60_000);

  it.fails(
    "[Medium, T2] guards a worksheet whose name has a '.' segment (xl/./worksheets/sheet1.xml)",
    async () => {
      // 220,000 merged cells: over the 100,000 cap, so a guarded sheet is
      // refused. Today it is accepted and exceljs applies the merge (the
      // sheet reads 98+ extra rows from a range like C3:XFD100).
      const bytes = await rawFixture((parts) =>
        [...parts].map(([name, data]): [string, Uint8Array] =>
          name === SHEET
            ? [
                "xl/./worksheets/sheet1.xml",
                bytesOf(
                  afterSheetData(
                    '<mergeCells count="1"><mergeCell ref="AH20:AH220020"/></mergeCells>',
                  )(text(data)),
                ),
              ]
            : [name, data],
        ),
      );
      expect(await safeOutcome(bytes)).toBe("refused");
    },
    60_000,
  );

  it.fails(
    "[Medium, T2] refuses a second workbook part that resolves onto xl/workbook.xml",
    async () => {
      const bytes = await rawFixture((parts) => {
        const workbook = text(parts.get("xl/workbook.xml"));
        const evil = workbook.replace(
          "</sheets>",
          '</sheets><definedNames><definedName name="x">Sheet1!$A$1:$B$2</definedName></definedNames>',
        );
        return [...parts, ["xl/a/../workbook.xml", bytesOf(evil)]];
      });
      const result = await checkImportFile(bytes);
      if (!result.ok) return; // refused: fixed
      const read = await readWorkbook(result.file);
      // The guard strips every <definedNames>; exceljs must see none.
      expect(read.ok && read.workbook.definedNames.model).toEqual([]);
    },
    60_000,
  );
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
        name === "xl/workbook.xml" ||
          /xl\/worksheets\/sheet\d+\.xml/.test(name),
      ).toBe(true);
    }
    const direct = new ExcelJS.Workbook();
    // exceljs types predate the generic Buffer (same cast as workbook.ts).
    await direct.xlsx.load(Buffer.from(original) as unknown as ExcelJS.Buffer);
    const read = await readWorkbook(result.file);
    if (!read.ok) throw new Error("unreadable");
    const sheet = direct.worksheets[0];
    const directRows: string[] = [];
    sheet?.eachRow((row, r) => {
      if (r > (read.sheets[0]?.headerRow ?? 1)) directRows.push(String(r));
    });
    expect(read.rows.map((r) => String(r.row))).toEqual(directRows);
  }, 60_000);
});
