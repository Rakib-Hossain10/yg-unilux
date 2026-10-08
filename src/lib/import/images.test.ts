// Tests for the image stage (Phase 3 T5) on the synthetic client sheet and
// its variants: oneCell / twoCell anchors mapped to Excel rows, sha256 dedupe
// per product, a picture shared by two products, variant pictures, other
// image stores, unsupported formats, size caps, linked and free pictures.

import { createHash, randomBytes } from "node:crypto";

import ExcelJS from "exceljs";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { MAX_IMAGE_BYTES, MAX_PRODUCT_IMAGES } from "@/lib/constants";

import {
  FIXTURE_DATA_ROWS,
  buildFixture,
  fixturePictures,
  type FixtureOptions,
} from "../../../test/fixtures/import/build";
import { checked } from "../../../test/fixtures/import/checked";
import {
  emfBytes,
  patchZip,
  readPart,
} from "../../../test/fixtures/import/patch-zip";
import { cleanRow } from "./clean";
import { groupRows } from "./group";
import {
  attachImages,
  readEmbeddedImages,
  type EmbeddedImages,
} from "./images";
import type { CheckedImportFile } from "./safety";
import type { ImportProduct, ImportWarning } from "./types";
import { readWorkbook } from "./workbook";

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/* The fixture pictures' sha256, A-E (computed from the bytes the builder uses). */
async function pictureShas(): Promise<string[]> {
  return (await fixturePictures()).map(sha);
}

interface Analysis {
  embedded: EmbeddedImages;
  products: ImportProduct[];
  warnings: ImportWarning[];
}

/* The pipeline up to images: read → clean → group → images → attach. */
async function analyse(bytes: Uint8Array): Promise<Analysis> {
  const read = await readWorkbook(await checked(bytes));
  if (!read.ok) throw new Error(JSON.stringify(read.warnings));
  const grouped = groupRows(read.rows.map(cleanRow), {
    categories: [],
    areas: [],
    defaultCategoryId: "default",
  });
  const embedded = await readEmbeddedImages(
    await checked(bytes),
    read.sheets.map((s) => s.name),
  );
  const attached = attachImages(grouped.products, embedded);
  return { embedded, ...attached };
}

async function fixture(options: FixtureOptions = {}): Promise<Analysis> {
  return analyse(await buildFixture(options));
}

function product(result: Analysis, no: number): ImportProduct {
  const found = result.products.find((p) => p.productNo === no);
  if (!found) throw new Error(`no product ${no}`);
  return found;
}

const imageWarnings = (p: ImportProduct) =>
  p.warnings
    .filter((w) => /image/.test(w.code))
    .map((w) => [w.code, w.row, w.column]);

describe("readEmbeddedImages + attachImages on the synthetic client sheet", () => {
  it("maps every oneCell anchor to its Excel row and dedupes per product", async () => {
    const [a, b, c, d] = await pictureShas();
    const result = await fixture();

    expect(result.embedded.warnings).toEqual([]);
    expect(
      result.embedded.anchors.map((x) => [x.row, x.column, x.sha256]),
    ).toEqual(
      FIXTURE_DATA_ROWS.map((row) => [
        row,
        6,
        row <= 6 ? a : row <= 10 ? b : row <= 12 ? c : d,
      ]),
    );
    expect([...result.embedded.files.keys()].sort()).toEqual(
      [a, b, c, d].sort(),
    );
    const fileA = result.embedded.files.get(a as string);
    expect(fileA).toMatchObject({ format: "png", width: 8, height: 8 });
    expect(fileA?.bytes).toBe(fileA?.data.length);
    expect(sha(fileA?.data as Uint8Array)).toBe(a);

    // One gallery image per product; 76+77 share A, 78+79 share B, and each
    // product still gets its own entry (Cloudinary ids are per product).
    expect(
      result.products.map((p) => [
        p.productNo,
        p.images.map((i) => [i.sha256, i.row]),
      ]),
    ).toEqual([
      [76, [[a, 3]]],
      [77, [[a, 5]]],
      [78, [[b, 7]]],
      [79, [[b, 9]]],
      [80, [[c, 11]]],
      [81, [[d, 13]]],
    ]);
    // Same picture on every row of a product → no variant picture.
    for (const p of result.products) {
      expect(p.variants.map((v) => v.imageSha256)).toEqual(
        p.variants.map(() => null),
      );
      expect(imageWarnings(p)).toEqual([]);
    }
    expect(result.warnings).toEqual([]);
  });

  it("reads twoCell anchors (the real sheet's kind) by their top-left cell", async () => {
    const [a, b] = await pictureShas();
    const result = await fixture({ twoCellRows: [3, 4, 7] });
    expect(result.embedded.warnings).toEqual([]);
    expect(
      result.embedded.anchors.slice(0, 5).map((x) => [x.row, x.sha256]),
    ).toEqual([
      [3, a],
      [4, a],
      [5, a],
      [6, a],
      [7, b],
    ]);
    expect(product(result, 76).images.map((i) => i.sha256)).toEqual([a]);
    expect(product(result, 78).images.map((i) => i.sha256)).toEqual([b]);
  });

  it("gives each variant its own picture when the product's rows differ", async () => {
    const [a, , , , e] = await pictureShas();
    const result = await fixture({ variantPicture: true });
    const p76 = product(result, 76);
    expect(p76.images.map((i) => [i.sha256, i.row])).toEqual([
      [a, 3],
      [e, 4],
    ]);
    expect(p76.variants.map((v) => [v.modelNo, v.imageSha256])).toEqual([
      ["AR-013A1", a],
      ["AR-013A2", e],
    ]);
    // No. 77 still shares A on both rows: no variant pictures there.
    expect(product(result, 77).variants.map((v) => v.imageSha256)).toEqual([
      null,
      null,
    ]);
  });

  it("puts two pictures of one row in the gallery, Image column first", async () => {
    const [a, , , , e] = await pictureShas();
    const result = await fixture({ secondPictureOnRow3: true });
    const p76 = product(result, 76);
    expect(p76.images.map((i) => [i.sha256, i.row])).toEqual([
      [a, 3],
      [e, 3],
    ]);
    // Both variant rows lead with A, so they do not differ.
    expect(p76.variants.map((v) => v.imageSha256)).toEqual([null, null]);
  });

  it("warns missing_image for a product with no picture, without blocking it", async () => {
    const result = await fixture({ noImageRows: [3, 4] });
    const p76 = product(result, 76);
    expect(p76.images).toEqual([]);
    expect(p76.blocked).toBe(false);
    expect(imageWarnings(p76)).toEqual([["missing_image", 3, "image"]]);
    expect(p76.warnings.find((w) => w.code === "missing_image")?.severity).toBe(
      "warning",
    );
  });

  it("warns image_not_on_row for a picture on a row of no product", async () => {
    const result = await fixture({ extraImageRows: [2] });
    expect(result.warnings.map((w) => [w.code, w.sheet, w.row])).toEqual([
      ["image_not_on_row", "Sheet1", 2],
    ]);
  });
});

describe("input", () => {
  it("reads no pictures for a sheet whose part exceljs would resolve differently", async () => {
    // We resolve "worksheets/../worksheets/sheet1.xml" to the real sheet;
    // exceljs splices it literally and finds no part. Rows and pictures must
    // never come from different parts, so the pictures are not read.
    const bytes = await patchZip(await buildFixture(), {
      "xl/_rels/workbook.xml.rels": (xml) =>
        xml.replace(
          'Target="worksheets/sheet1.xml"',
          'Target="worksheets/../worksheets/sheet1.xml"',
        ),
    });
    const embedded = await readEmbeddedImages(await checked(bytes), ["Sheet1"]);
    expect(embedded.anchors).toEqual([]);
    expect(embedded.warnings.map((w) => [w.code, w.sheet])).toEqual([
      ["unsupported_image_store", "Sheet1"],
    ]);
  });

  it("never reads bytes that did not come from checkImportFile", async () => {
    const forged = {
      bytes: await buildFixture(),
    } as unknown as CheckedImportFile;
    await expect(readEmbeddedImages(forged, ["Sheet1"])).rejects.toThrow(
      /checkImportFile/,
    );
  });
});

describe("other image stores", () => {
  it("warns unsupported_image_store when WPS cellimages.xml is present", async () => {
    const bytes = await patchZip(await buildFixture(), {
      "xl/cellimages.xml":
        '<?xml version="1.0"?><etc:cellImages xmlns:etc="http://www.wps.cn/officeDocument/2017/etCustomData"/>',
    });
    const result = await analyse(bytes);
    expect(result.embedded.warnings.map((w) => [w.code, w.sheet])).toEqual([
      ["unsupported_image_store", null],
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual([
      "unsupported_image_store",
    ]);
    // The standard anchors are still read.
    expect(product(result, 76).images).toHaveLength(1);
  });

  it("warns unsupported_image_store for Excel richData (Place in Cell)", async () => {
    const bytes = await patchZip(await buildFixture(), {
      "xl/richData/richValueRel.xml": '<?xml version="1.0"?><richValueRels/>',
      "xl/richData/rdrichvalue.xml": '<?xml version="1.0"?><rvData/>',
    });
    const result = await analyse(bytes);
    expect(result.embedded.warnings.map((w) => w.code)).toEqual([
      "unsupported_image_store",
    ]);
  });

  it("ignores richData parts that are not pictures (Stocks, Geography)", async () => {
    const bytes = await patchZip(await buildFixture(), {
      "xl/richData/rdrichvalue.xml": '<?xml version="1.0"?><rvData/>',
      "xl/richData/rdrichvaluestructure.xml":
        '<?xml version="1.0"?><rvStructures/>',
    });
    const result = await analyse(bytes);
    expect(result.embedded.warnings).toEqual([]);
  });
});

describe("picture checks", () => {
  it("refuses an EMF picture (unsupported_image on each row) and reports missing_image", async () => {
    const bytes = await patchZip(await buildFixture(), {
      "xl/media/image3.png": emfBytes(),
    });
    const result = await analyse(bytes);
    const p80 = product(result, 80);
    expect(p80.images).toEqual([]);
    expect(imageWarnings(p80)).toEqual([
      ["unsupported_image", 11, "image"],
      ["unsupported_image", 12, "image"],
      ["missing_image", 11, "image"],
    ]);
    expect(
      p80.warnings.find((w) => w.code === "unsupported_image")?.detail,
    ).toMatch(/EMF/);
    expect(result.embedded.files.size).toBe(3);
  });

  it("refuses GIF and an unreadable PNG", async () => {
    const gif = await sharp({
      create: { width: 4, height: 4, channels: 3, background: "red" },
    })
      .gif()
      .toBuffer();
    const junkPng = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]);
    const bytes = await patchZip(await buildFixture(), {
      "xl/media/image3.png": gif,
      "xl/media/image4.png": junkPng,
    });
    const result = await analyse(bytes);
    const detail = (no: number) =>
      product(result, no).warnings.find((w) => w.code === "unsupported_image")
        ?.detail;
    expect(detail(80)).toMatch(/GIF/);
    expect(detail(81)).toMatch(/could not be read/);
  });

  it("flags a picture over 10 MB without reading it", async () => {
    // Random (incompressible) bytes: zeros would trip the zip ratio check.
    const big = new Uint8Array(randomBytes(MAX_IMAGE_BYTES + 1));
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bytes = await patchZip(await buildFixture(), {
      "xl/media/image4.png": big,
    });
    const metadata = vi.spyOn(sharp.prototype, "metadata");
    const result = await analyse(bytes);
    const p81 = product(result, 81);
    expect(imageWarnings(p81)).toEqual([
      ["image_too_large", 13, "image"],
      ["image_too_large", 14, "image"],
      ["missing_image", 13, "image"],
    ]);
    // Only the three readable pictures reached sharp.
    expect(metadata).toHaveBeenCalledTimes(3);
  }, 30_000); // a 10 MB incompressible part: deflate + check take seconds under load

  it("flags a picture above the pixel cap", async () => {
    const huge = await sharp({
      create: { width: 5001, height: 5000, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const bytes = await patchZip(await buildFixture(), {
      "xl/media/image4.png": huge,
    });
    const result = await analyse(bytes);
    expect(imageWarnings(product(result, 81))[0]).toEqual([
      "image_too_large",
      13,
      "image",
    ]);
  });

  it("refuses a linked (not embedded) picture and never fetches it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const bytes = await patchZip(await buildFixture(), {
      "xl/drawings/drawing1.xml": (xml) =>
        xml.replace('r:embed="rId1"', 'r:link="rId99"'),
      "xl/drawings/_rels/drawing1.xml.rels": (xml) =>
        xml.replace(
          "</Relationships>",
          '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/a.png" TargetMode="External"/></Relationships>',
        ),
    });
    const result = await analyse(bytes);
    const p76 = product(result, 76);
    expect(imageWarnings(p76)).toEqual([["unsupported_image", 3, "image"]]);
    expect(p76.images.map((i) => i.row)).toEqual([4]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("warns for a picture whose file is missing from the package", async () => {
    const bytes = await patchZip(await buildFixture(), {
      "xl/drawings/_rels/drawing1.xml.rels": (xml) =>
        xml.replace("../media/image4.png", "../media/nothing.png"),
    });
    const result = await analyse(bytes);
    expect(imageWarnings(product(result, 81))).toEqual([
      ["unsupported_image", 13, "image"],
      ["unsupported_image", 14, "image"],
      ["missing_image", 13, "image"],
    ]);
  });

  it("warns image_not_on_row for an absolute (free-floating) anchor", async () => {
    const bytes = await patchZip(await buildFixture(), {
      "xl/drawings/drawing1.xml": (xml) =>
        xml.replace(
          /<xdr:oneCellAnchor editAs="oneCell"><xdr:from>.*?<\/xdr:from><xdr:ext cx="609600" cy="609600"\/>(.*?)<\/xdr:oneCellAnchor>/,
          '<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="609600" cy="609600"/>$1</xdr:absoluteAnchor>',
        ),
    });
    const result = await analyse(bytes);
    expect(result.warnings.map((w) => [w.code, w.sheet, w.row])).toEqual([
      ["image_not_on_row", "Sheet1", undefined],
    ]);
    // Row 3 lost its picture, row 4 still carries A.
    expect(product(result, 76).images.map((i) => i.row)).toEqual([4]);
  });

  it("refuses a drawing with a DOCTYPE (no entity expansion) with one file warning", async () => {
    const bytes = await patchZip(await buildFixture(), {
      "xl/drawings/drawing1.xml":
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaa">]><xdr:wsDr xmlns:xdr="x">&a;</xdr:wsDr>',
    });
    // exceljs refuses this file too, so the reader is called directly.
    const embedded = await readEmbeddedImages(await checked(bytes), ["Sheet1"]);
    expect(embedded.anchors).toEqual([]);
    expect(embedded.files.size).toBe(0);
    expect(embedded.warnings.map((w) => [w.code, w.sheet])).toEqual([
      ["unsupported_image_store", "Sheet1"],
    ]);
  });

  it("reads one branch of an mc:AlternateContent inside an anchor", async () => {
    const [a] = await pictureShas();
    const base = await buildFixture();
    const rels = new TextDecoder().decode(
      await readPart(base, "xl/drawings/_rels/drawing1.xml.rels"),
    );
    const idOf = (media: string) =>
      new RegExp(`Id="(rId[0-9]+)"[^>]*Target="../media/${media}"`).exec(
        rels,
      )?.[1];
    const [idA, idB] = [idOf("image1.png"), idOf("image2.png")];
    expect([idA, idB].every(Boolean)).toBe(true);
    const bytes = await patchZip(base, {
      "xl/drawings/drawing1.xml": (xml) =>
        xml.replace(/(<xdr:pic>.*?<\/xdr:pic>)/, (pic: string) => {
          const fallback = pic.replace(`r:embed="${idA}"`, `r:embed="${idB}"`);
          return `<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="a14">${pic}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;
        }),
    });
    const embedded = await readEmbeddedImages(await checked(bytes), ["Sheet1"]);
    // Only the Choice branch counts: the Fallback's picture B is not added.
    expect(
      embedded.anchors.filter((x) => x.row === 3).map((x) => x.sha256),
    ).toEqual([a]);
  });

  it("finds a sheet whose name needs XML escaping", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("R&D <new>");
    sheet.getCell(1, 1).value = "NO.";
    sheet.getCell(1, 2).value = "Model No.";
    sheet.getCell(1, 3).value = "Image";
    sheet.getCell(2, 1).value = 1;
    sheet.getCell(2, 2).value = "XY-100";
    const [picture] = await fixturePictures();
    const id = workbook.addImage({
      buffer: picture as unknown as ExcelJS.Buffer,
      extension: "png",
    });
    sheet.addImage(id, {
      tl: { col: 2, row: 1 },
      ext: { width: 10, height: 10 },
    });
    const result = await analyse(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );
    expect(result.products.map((p) => p.images.length)).toEqual([1]);
    expect(result.embedded.anchors[0]).toMatchObject({
      sheet: "R&D <new>",
      row: 2,
      column: 3,
    });
  });
});

describe("attachImages (pure)", () => {
  /* A minimal product on Sheet1 with one variant per row. */
  function bare(no: number, rows: number[]): ImportProduct {
    return {
      sheet: "Sheet1",
      productNo: no,
      rows,
      family: "Arc",
      type: null,
      baseModelCode: `M-${no}`,
      name: `Arc M-${no}`,
      slug: `arc-m-${no}`,
      specs: {},
      variants: rows.map((row) => ({
        modelNo: `M-${no}-${row}`,
        modelNoKey: `m-${no}-${row}`,
        label: `M-${no}-${row}`,
        specs: {},
        sheet: "Sheet1",
        row,
        imageSha256: null,
      })),
      images: [],
      mainCategory: "default",
      mainCategoryFromSheet: false,
      extraCategories: [],
      extraCategoriesFromSheet: false,
      areas: [],
      areasFromSheet: false,
      trackSize: null,
      blocked: false,
      warnings: [],
    };
  }

  const hex = (n: number) => n.toString(16).padStart(64, "0");

  it(`caps the gallery at ${MAX_PRODUCT_IMAGES} pictures with a warning`, () => {
    const count = MAX_PRODUCT_IMAGES + 2;
    const embedded: EmbeddedImages = {
      anchors: Array.from({ length: count }, (_, k) => ({
        sheet: "Sheet1",
        row: 3,
        column: k + 1,
        sha256: hex(k + 1),
        issue: null,
      })),
      files: new Map(),
      warnings: [],
    };
    const [p] = attachImages([bare(1, [3])], embedded).products;
    expect(p?.images).toHaveLength(MAX_PRODUCT_IMAGES);
    expect(p?.images[0]?.sha256).toBe(hex(1));
    expect(p?.warnings.map((w) => [w.code, w.row, w.column])).toEqual([
      ["value_truncated", 3, "image"],
    ]);
  });

  it("does not mutate its input and keeps rows of other sheets apart", () => {
    const input = bare(1, [3, 4]);
    const embedded: EmbeddedImages = {
      anchors: [
        { sheet: "Sheet2", row: 3, column: 6, sha256: hex(9), issue: null },
        { sheet: "Sheet1", row: 4, column: 6, sha256: hex(2), issue: null },
      ],
      files: new Map(),
      warnings: [],
    };
    const result = attachImages([input], embedded);
    expect(input.images).toEqual([]);
    expect(result.products[0]?.images.map((i) => i.sha256)).toEqual([hex(2)]);
    // One variant with a picture, one without: they do not "differ".
    expect(result.products[0]?.variants.map((v) => v.imageSha256)).toEqual([
      null,
      null,
    ]);
    expect(result.warnings.map((w) => [w.code, w.sheet, w.row])).toEqual([
      ["image_not_on_row", "Sheet2", 3],
    ]);
  });
});
