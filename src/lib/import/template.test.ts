// The import template (ADR 0059): its layout, and the golden round trip
// generate -> fill -> checkImportFile -> read -> clean -> group with ZERO warnings.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { MAX_TEMPLATE_ROWS } from "@/lib/constants";

import { FIXTURE_HEADERS } from "../../../test/fixtures/import/build";
import { checked, partsOf } from "../../../test/fixtures/import/checked";
import {
  TEMPLATE_AREAS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_INPUT,
  fillTemplate,
  goldenTemplateFile,
} from "../../../test/fixtures/import/template-fixture";
import { cleanRow } from "./clean";
import { columnForHeader } from "./columns";
import { groupRows } from "./group";
import { attachImages, readEmbeddedImages } from "./images";
import { checkImportFile } from "./safety";
import { buildImportTemplate, categoryPaths } from "./template";
import { readWorkbook } from "./workbook";

const text = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

async function template(): Promise<Uint8Array> {
  return buildImportTemplate(TEMPLATE_INPUT);
}

async function roundTrip(bytes: Buffer) {
  const file = await checked(bytes);
  const read = await readWorkbook(file);
  if (!read.ok) throw new Error(JSON.stringify(read.warnings));
  const group = groupRows(read.rows.map(cleanRow), {
    categories: TEMPLATE_CATEGORIES,
    areas: TEMPLATE_AREAS,
    defaultCategoryId: "c-default",
  });
  const embedded = await readEmbeddedImages(
    file,
    read.sheets.map((s) => s.name),
  );
  const attached = attachImages(group.products, embedded);
  return { read, group, attached };
}

describe("buildImportTemplate layout", () => {
  it("starts with the client's 33 headers in order, then the template columns", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      Buffer.from(await template()) as unknown as ExcelJS.Buffer,
    );
    const headers: string[] = [];
    wb.getWorksheet("Products")
      ?.getRow(1)
      .eachCell((c, i) => {
        headers[i - 1] = String(c.value);
      });
    const english = FIXTURE_HEADERS.map((h) => (h.split("\n")[0] ?? "").trim());
    expect(headers.slice(0, 33).map((h) => h.toLowerCase())).toEqual(
      english.map((h) => h.toLowerCase()),
    );
    expect(headers.slice(33)).toEqual([
      "Category",
      "Extra Category 1",
      "Extra Category 2",
      "Area: Residential",
      "Area: Retail",
      "Area: Hospitality",
    ]);
    // English only, and every header is understood by the parser.
    for (const h of headers) {
      expect(h).not.toMatch(/[　-鿿]/);
      expect(columnForHeader(h)).not.toBeNull();
    }
  });

  it("has a bold frozen header, a very hidden Lists sheet and header notes", async () => {
    const parts = partsOf(await template());
    const workbookXml = text(parts.get("xl/workbook.xml"));
    expect(workbookXml).toMatch(/name="Lists"[^>]*state="veryHidden"/);
    expect(workbookXml).not.toContain("definedName");
    const sheetXml = text(parts.get("xl/worksheets/sheet1.xml"));
    expect(sheetXml).toMatch(/<pane [^>]*state="frozen"/);
    expect(sheetXml).toContain('ySplit="1"');
    const comments = text(parts.get("xl/comments1.xml"));
    expect(comments).toContain("One row per variant");
    expect(comments).toContain("never repeated");
    expect(comments).toContain("one picture");
    expect(comments).toContain("Do not merge cells");
    expect(comments).toContain("dropdown");
  });

  it("uses strict list validation on bounded ranges that point at Lists", async () => {
    const parts = partsOf(await template());
    const xml = text(parts.get("xl/worksheets/sheet1.xml"));
    const validations = [
      ...xml.matchAll(/<dataValidation [^>]*>[\s\S]*?<\/dataValidation>/g),
    ].map((m) => m[0]);
    // Category, 2 extras, 3 areas.
    expect(validations).toHaveLength(6);
    for (const v of validations) {
      expect(v).toContain('type="list"');
      expect(v).toContain('errorStyle="stop"');
      expect(v).toContain('showErrorMessage="1"');
      const sqref = /sqref="([A-Z]+)2:([A-Z]+)(\d+)"/.exec(v);
      expect(sqref?.[1]).toBe(sqref?.[2]);
      expect(Number(sqref?.[3])).toBe(MAX_TEMPLATE_ROWS + 1);
      expect(v).toMatch(/<formula1>Lists!\$[AB]\$2:\$[AB]\$\d+<\/formula1>/);
    }
  });

  it("lists Main and Main > Sub category paths, in tree order", () => {
    expect(categoryPaths(TEMPLATE_CATEGORIES)).toEqual([
      "Spot Lights",
      "Spot Lights > Recessed",
      "Recessed Lights",
      "Recessed Lights > Spot",
    ]);
  });

  it("passes the safety check and the sheet guard (validations are stripped)", async () => {
    const result = await checkImportFile(await template());
    expect(result.ok).toBe(true);
  });

  it("builds without validations when there are no categories or areas", async () => {
    const bytes = await buildImportTemplate({ categories: [], areas: [] });
    const xml = text(partsOf(bytes).get("xl/worksheets/sheet1.xml"));
    expect(xml).not.toContain("dataValidation");
  });
});

describe("template round trip (golden)", () => {
  it("reads a filled template with zero warnings and the golden products", async () => {
    const { read, group, attached } = await roundTrip(
      await goldenTemplateFile(),
    );
    expect(read.warnings).toEqual([]);
    expect(group.warnings).toEqual([]);
    expect(attached.warnings).toEqual([]);
    expect(attached.products.flatMap((p) => p.warnings)).toEqual([]);
    expect(read.sheets.map((s) => s.name)).toEqual(["Products"]);

    expect(attached.products).toHaveLength(3);
    const [arc, beam, beam2] = attached.products;
    expect(arc?.name).toBe("Arc AR-013A");
    expect(arc?.productNo).toBe(76);
    expect(arc?.variants.map((v) => v.modelNo)).toEqual([
      "AR-013A1",
      "AR-013A2",
    ]);
    expect(arc?.variants[0]?.specs.lumenOutput).toEqual(["1140 LM"]);
    expect(arc?.variants[1]?.specs.lumenOutput).toEqual(["1200 LM"]);
    expect(arc?.variants[0]?.specs.lens).toEqual(["Regular Lens"]);
    expect(arc?.variants[1]?.specs.reflector).toEqual([
      "High Efficiency Reflector",
    ]);
    expect(arc?.specs.cct).toEqual(["3000K", "4000K"]);
    expect(arc?.specs.beamAngle).toEqual(["20°", "30°"]);
    expect(arc?.mainCategory).toBe("c-spot-rec");
    expect(arc?.mainCategoryFromSheet).toBe(true);
    expect(arc?.extraCategories).toEqual(["c-rec-spot"]);
    expect(arc?.areas).toEqual(["a-res", "a-ret"]);
    expect(arc?.images).toHaveLength(1);
    expect(beam?.productNo).toBe(77);
    expect(beam?.areas).toEqual(["a-ret"]);
    expect(beam?.areasFromSheet).toBe(true);
    // NO. repeated on the directly following row = one product, two variants.
    expect(beam2?.productNo).toBe(78);
    expect(beam2?.variants.map((v) => v.modelNo)).toEqual([
      "BM-002A1",
      "BM-002A2",
    ]);
    expect(beam2?.images).toHaveLength(1);
  });

  it("skips the Lists sheet silently", async () => {
    const { read } = await roundTrip(await goldenTemplateFile());
    expect(
      read.warnings.filter(
        (w) => w.sheet === "Lists" || w.code === "sheet_skipped",
      ),
    ).toEqual([]);
  });

  it("reads an empty template (header only) as zero rows", async () => {
    const read = await readWorkbook(
      await checked(Buffer.from(await template())),
    );
    expect(read.ok && read.rows).toEqual([]);
  });

  it("does not turn rows holding only No area flags into data rows", async () => {
    const bytes = await fillTemplate(await template(), [
      { row: { "Area: Retail": "No", "Area: Residential": "No" } },
    ]);
    const { read } = await roundTrip(bytes);
    expect(read.rows).toEqual([]);
  });
});
