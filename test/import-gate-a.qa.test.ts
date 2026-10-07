// Phase 3 QA gate A (T1-T5: import parser and its safety). Independent attack
// tests on the zip pre-check, the XML reader, the image checks, the cleaner,
// the filter parsers and grouping. `it.fails` = a confirmed defect (see the
// gate A report); it flips to a failure once the defect is fixed.

import { crc32, deflateSync } from "node:zlib";

import JSZip from "jszip";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { cleanRow, cleanSpecCell } from "@/lib/import/clean";
import { groupRows, type CategoryLookup } from "@/lib/import/group";
import { attachImages, readEmbeddedImages } from "@/lib/import/images";
import {
  filtersFromSpecs,
  parseBeamDeg,
  parseCctK,
  parseCri,
  parseIp,
  parseUgr,
  parseWattage,
} from "@/lib/import/numbers";
import { parseXml, resolveTarget } from "@/lib/import/ooxml";
import { checkImportFile } from "@/lib/import/safety";
import type { ColumnKey, SheetRow } from "@/lib/import/types";
import { readWorkbook } from "@/lib/import/workbook";
import { SLUG_PATTERN } from "@/lib/slug";
import { checkXlsx } from "@/lib/xlsx-signature";

import { buildFixture } from "./fixtures/import/build";
import { patchZip } from "./fixtures/import/patch-zip";
import { rawZip } from "./fixtures/import/raw-zip";

const enc = new TextEncoder();
const WORKBOOK_TYPES =
  '<?xml version="1.0"?><Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';

/* Adds a fragment to the fixture's sheet1.xml right after </sheetData>. */
const afterSheetData = (fragment: string) => (xml: string) =>
  xml.replace("</sheetData>", `</sheetData>${fragment}`);

/* ------------------------------------------------------------------------ *
 * 1. Zip safety
 * ------------------------------------------------------------------------ */

describe("gate A: zip safety", () => {
  it("refuses a stored entry whose two declared sizes differ", async () => {
    const bytes = rawZip([
      { name: "[Content_Types].xml", data: enc.encode(WORKBOOK_TYPES) },
      { name: "xl/workbook.xml", data: enc.encode("<workbook/>") },
      { name: "xl/a.xml", data: enc.encode("<a/>"), uncompressedSize: 9999 },
    ]);
    const result = await checkImportFile(bytes);
    expect(result.ok).toBe(false);
  });

  it("refuses many small entries that together pass the total cap", async () => {
    // 400 x 1 MB at ~1000:1 each: every entry is under the 1 MB ratio floor,
    // so only the 300 MB total cap stops it.
    const zip = new JSZip();
    zip.file("[Content_Types].xml", WORKBOOK_TYPES);
    zip.file("xl/workbook.xml", "<workbook/>");
    const mb = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 301; i++) zip.file(`xl/pad${i}.bin`, mb);
    const bytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
    });
    const result = await checkImportFile(bytes);
    expect(result).toEqual({ ok: false, reason: "uncompressed_too_large" });
  }, 60_000);

  it.fails(
    "[Low, T2] refuses two part names that differ only by case (OPC equivalence)",
    async () => {
      const fixture = await buildFixture();
      const workbook = await new JSZip()
        .loadAsync(fixture)
        .then((z) => z.file("xl/workbook.xml")?.async("string"));
      const bytes = await patchZip(fixture, {
        "XL/WORKBOOK.XML": workbook ?? "<workbook/>",
      });
      const result = await checkImportFile(bytes);
      expect(result.ok).toBe(false);
    },
  );

  // exceljs expands these ranges cell by cell on load (Worksheet
  // _mergeCellsInternal, DataValidationsXform.parseClose, DefinedNames.addEx):
  // a few bytes in the sheet = billions of iterations / GBs of heap, after
  // every zip check passed. Measured: a 6.4 KB file with C3:XFD100 merged
  // takes 4.7 s and 423 MB; C3:XFD1048576 never finishes.
  it.fails(
    "[Medium, T2/T7] refuses (or bounds) a merge range covering the whole grid",
    async () => {
      const bytes = await patchZip(await buildFixture(), {
        "xl/worksheets/sheet1.xml": afterSheetData(
          '<mergeCells count="1"><mergeCell ref="AH20:XFD1048576"/></mergeCells>',
        ),
      });
      expect((await checkImportFile(bytes)).ok).toBe(false);
    },
  );

  it.fails(
    "[Medium, T2/T7] refuses (or bounds) a data validation over the whole grid",
    async () => {
      const bytes = await patchZip(await buildFixture(), {
        "xl/worksheets/sheet1.xml": (xml) =>
          xml.replace(
            /<pageMargins/,
            '<dataValidations count="1"><dataValidation type="whole" sqref="A20:XFD1048576"><formula1>1</formula1></dataValidation></dataValidations><pageMargins',
          ),
      });
      expect((await checkImportFile(bytes)).ok).toBe(false);
    },
  );

  it.fails(
    "[Medium, T2/T7] refuses (or bounds) a defined name over the whole grid",
    async () => {
      const bytes = await patchZip(await buildFixture(), {
        "xl/workbook.xml": (xml) =>
          xml.replace(
            "</sheets>",
            '</sheets><definedNames><definedName name="x">Sheet1!$A$1:$XFD$1048576</definedName></definedNames>',
          ),
      });
      expect((await checkImportFile(bytes)).ok).toBe(false);
    },
  );

  it("datasheet check (checkXlsx) still accepts the synthetic client sheet", async () => {
    // The fixture has deflated parts and pictures: the stricter
    // readZipPart must not reject an ordinary workbook.
    expect(await checkXlsx(await buildFixture())).toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------------ *
 * 2. XML reader (ooxml.ts)
 * ------------------------------------------------------------------------ */

/* Runs fn and returns its duration in ms. */
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("gate A: XML reader", () => {
  it("refuses DOCTYPE / entity declarations in any case and never expands them", () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><x>&b;</x>';
    expect(parseXml(bomb)).toBeNull();
    expect(parseXml("<!doctype x><x/>")).toBeNull();
    expect(parseXml('<!ENTITY a "b"><x/>')).toBeNull();
    // An undeclared entity is left as literal text, not resolved.
    expect(parseXml("<x>&ext;</x>")?.text).toBe("&ext;");
  });

  it("keeps CDATA as text and skips comments and processing instructions", () => {
    const el = parseXml("<?pi x?><x><!-- <y/> --><![CDATA[<z/>&amp;]]></x>");
    expect(el?.children).toEqual([]);
    expect(el?.text).toBe("<z/>&amp;");
  });

  it("refuses deep nesting and too many nodes quickly", () => {
    const deep = "<a>".repeat(100_000) + "</a>".repeat(100_000);
    let result: unknown = "unset";
    expect(timed(() => (result = parseXml(deep)))).toBeLessThan(500);
    expect(result).toBeNull();
    const wide = `<r>${"<a/>".repeat(600_000)}</r>`;
    expect(timed(() => (result = parseXml(wide)))).toBeLessThan(2000);
    expect(result).toBeNull();
  });

  it("stays linear on adversarial input (2 MB each)", () => {
    const n = 2_000_000;
    const cases = [
      "<".repeat(n),
      `<a b="${"x".repeat(n)}`,
      "<!--".repeat(n / 4),
      `<a>${"&amp;".repeat(n / 5)}</a>`,
      `<a ${'x="<>" '.repeat(n / 8)}/>`,
      `<a>${"<![CDATA[".repeat(n / 9)}`,
      `<a b='">`.repeat(n / 8),
    ];
    for (const text of cases)
      expect(timed(() => parseXml(text))).toBeLessThan(1500);
  });

  it("never pollutes Object.prototype through attribute or element names", () => {
    const el = parseXml(
      '<__proto__ __proto__="x" constructor="y" prototype="z"><a toString="1"/></__proto__>',
    );
    expect(el?.attrs.constructor).toBe("y");
    expect(Object.getPrototypeOf(el?.attrs ?? {})).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "x")).toBe(
      false,
    );
  });

  it("resolves relationship targets without climbing out of the package", () => {
    const from = "xl/drawings/drawing1.xml";
    expect(resolveTarget(from, "../media/image1.png")).toBe(
      "xl/media/image1.png",
    );
    expect(resolveTarget(from, "/xl/media/a.png")).toBe("xl/media/a.png");
    expect(resolveTarget(from, "../../../etc/passwd")).toBeNull();
    expect(resolveTarget(from, "%2e%2e/%2e%2e/%2e%2e/x")).toBeNull();
    expect(resolveTarget(from, "%E0%A4%A")).toBeNull(); // malformed escape
    expect(resolveTarget(from, "")).toBeNull();
    expect(resolveTarget(from, "../media/")).toBeNull();
    // Only zip entry names are ever looked up (no filesystem), so these stay
    // inert names inside the package:
    const bs = String.fromCharCode(92);
    const back = `..${bs}..${bs}x`;
    expect(resolveTarget(from, back)).toBe(`xl/drawings/${back}`);
    expect(resolveTarget(from, "%252e%252e/x")).toBe("xl/drawings/%2e%2e/x");
    expect(resolveTarget(from, "http://169.254.169.254/x")).toBe(
      "xl/drawings/http:/169.254.169.254/x",
    );
  });

  it("never fetches a linked picture (no SSRF), whatever the target", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const bytes = await patchZip(await buildFixture(), {
      "xl/drawings/_rels/drawing1.xml.rels": (xml) =>
        xml.replaceAll(
          'Target="../media/',
          'TargetMode="External" Target="http://169.254.169.254/latest/',
        ),
    });
    const embedded = await readEmbeddedImages(bytes, ["Sheet1"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(embedded.files.size).toBe(0);
    expect(
      embedded.anchors.every((a) => a.issue?.code === "unsupported_image"),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Images
 * ------------------------------------------------------------------------ */

/* A PNG whose header claims width x height but holds one tiny IDAT. */
function pngHeaderBomb(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(enc.encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(64)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/* The fixture with xl/media/image1.png replaced by other bytes. */
async function withPicture(data: Uint8Array) {
  const bytes = await patchZip(await buildFixture(), {
    "xl/media/image1.png": data,
  });
  return readEmbeddedImages(bytes, ["Sheet1"]);
}

const issuesOf = (embedded: Awaited<ReturnType<typeof withPicture>>) =>
  [...new Set(embedded.anchors.map((a) => a.issue?.code ?? "ok"))].sort();

describe("gate A: images", () => {
  it("trusts the magic bytes, not the part name (JPEG bytes in a .png part)", async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#888" },
    })
      .jpeg()
      .toBuffer();
    const embedded = await withPicture(new Uint8Array(jpeg));
    const formats = [...embedded.files.values()].map((f) => f.format);
    expect(formats).toContain("jpeg");
  });

  it("refuses SVG, HEIF, BMP and unknown bytes before sharp sees them", async () => {
    const samples = [
      enc.encode(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      ),
      new Uint8Array([0, 0, 0, 24, ...enc.encode("ftypheic"), 0, 0, 0, 0]),
      enc.encode("BM" + "x".repeat(60)),
      enc.encode("hello"),
    ];
    for (const data of samples) {
      const embedded = await withPicture(data);
      expect(issuesOf(embedded)).toContain("unsupported_image");
      for (const file of embedded.files.values()) {
        expect(["jpeg", "png", "webp"]).toContain(file.format);
      }
    }
  });

  it("refuses a decompression-bomb PNG by its header, without decoding it", async () => {
    const start = performance.now();
    const embedded = await withPicture(pngHeaderBomb(50_000, 50_000));
    expect(performance.now() - start).toBeLessThan(3000);
    expect(issuesOf(embedded)).toContain("image_too_large");
  });

  it("keys each picture by the sha256 of its exact bytes", async () => {
    const embedded = await readEmbeddedImages(await buildFixture(), ["Sheet1"]);
    const { createHash } = await import("node:crypto");
    for (const [sha, file] of embedded.files) {
      expect(createHash("sha256").update(file.data).digest("hex")).toBe(sha);
    }
  });

  it("reports pictures on rows of no product and never invents a row", async () => {
    const bytes = await buildFixture();
    const read = await readWorkbook(bytes);
    if (!read.ok) throw new Error("fixture unreadable");
    const embedded = await readEmbeddedImages(bytes, ["Sheet1"]);
    // No products at all: every anchored picture must be reported, none kept.
    const result = attachImages([], embedded);
    const notOnRow = result.warnings.filter(
      (w) => w.code === "image_not_on_row",
    );
    expect(notOnRow.length).toBe(embedded.anchors.length);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. Cleaning and filter parsers
 * ------------------------------------------------------------------------ */

/* Independent CJK test by Unicode block (not the cleaner's CJK_CLASS). */
const CJK_BLOCKS: readonly [number, number][] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2fff], // radicals, Kangxi, ideographic description
  [0x3000, 0x4dbf], // CJK punctuation, kana, bopomofo, strokes, ext. A
  [0x4e00, 0x9fff], // unified ideographs
  [0xa960, 0xa97f],
  [0xac00, 0xd7ff], // Hangul syllables
  [0xf900, 0xfaff], // compatibility ideographs
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60], // full-width forms
  [0xff61, 0xffdc], // half-width CJK
  [0x20000, 0x323af],
];
const isCjk = (cp: number) => CJK_BLOCKS.some(([a, b]) => cp >= a && cp <= b);
const hasCjk = (text: string) =>
  Array.from(text).some((ch) => isCjk(ch.codePointAt(0) ?? 0));
const at = { sheet: "Sheet1", row: 3 };

describe("gate A: cleaning", () => {
  it("strips every assigned Han, kana, Hangul and Bopomofo character", () => {
    const leaks: string[] = [];
    const script =
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]/u;
    for (const [a, b] of CJK_BLOCKS) {
      for (let cp = a; cp <= b; cp++) {
        const ch = String.fromCodePoint(cp);
        if (!script.test(ch)) continue;
        const out = cleanSpecCell("driver", `Lifud ${ch}X`, at).values ?? [];
        if (out.some((v) => script.test(v))) leaks.push(cp.toString(16));
      }
    }
    expect(leaks).toEqual([]);
  });

  it.fails(
    "[Low, T3] strips CJK punctuation of Script=Common (katakana middle dot, prolonged mark, strokes, IDCs)",
    () => {
      // "白色・黑色" is how a Chinese/Japanese cell may separate two colours;
      // today it leaves "・" as a stored option. U+30FB, U+30FC, U+31C0,
      // U+2FF0, U+3190 and half-width U+FF65 all survive the strip.
      const cells = [
        "白色・黑色",
        "Lifud・莱福德",
        "铝ー",
        String.fromCodePoint(0x31c0),
        String.fromCodePoint(0x2ff0),
        String.fromCodePoint(0x3190),
        String.fromCodePoint(0xff65),
        String.fromCodePoint(0x3300), // NFKC: katakana + U+30FC
      ];
      for (const cell of cells) {
        const out = cleanSpecCell("housingFinish", cell, at).values ?? [];
        expect(out.filter(hasCjk)).toEqual([]);
      }
    },
  );

  it("cleans 400 KB adversarial cells in linear time", () => {
    const n = 100_000;
    const cells = [
      "(白".repeat(n),
      "白/".repeat(n),
      "白" + " / ".repeat(n) + "白",
      " ".repeat(4 * n) + "x",
      "a白".repeat(n),
      "白 -".repeat(n) + "1",
    ];
    for (const cell of cells) {
      expect(
        timed(() => cleanSpecCell("housingFinish", cell, at)),
      ).toBeLessThan(2000);
    }
  });
});

const PARSERS = [
  parseCctK,
  parseCri,
  parseBeamDeg,
  parseUgr,
  parseWattage,
  parseIp,
];

describe("gate A: filter parsers", () => {
  it("never yields NaN, Infinity or an out-of-bounds number", () => {
    const odd = [
      "9".repeat(400) + "K",
      "1e309W",
      "95±",
      "≤3",
      "3000K±200K",
      "-20°",
      "NaN W",
      "Infinity K",
      "0x10W",
      "1.7976931348623157e308K",
      "１２Ｗ",
      "12,,000K",
      "2700-6500K-",
      ".5W",
      "IP99",
    ];
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const alphabet = "0123456789.,-~/×x*°KkWwRa<>≤≥±+ IPdeg";
    for (let i = 0; i < 3000; i++) {
      let s = "";
      for (let j = 0; j < 1 + Math.floor(rand() * 30); j++) {
        s += alphabet[Math.floor(rand() * alphabet.length)];
      }
      odd.push(s);
    }
    for (const value of odd) {
      for (const parse of PARSERS) {
        for (const n of parse(value)) {
          expect(Number.isFinite(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(10_000);
        }
      }
    }
    const filters = filtersFromSpecs(
      odd.map((v) => ({
        cct: [v],
        cri: [v],
        beamAngle: [v],
        ugr: [v],
        wattage: [v],
        ipRating: [v],
      })),
    );
    for (const list of Object.values(filters)) {
      for (const n of list ?? []) expect(Number.isFinite(n)).toBe(true);
    }
  });

  it("parses one capped 500-character value fast (normal shapes)", () => {
    const shapes = [
      "1" + "a".repeat(499),
      "1a".repeat(250),
      "1" + ",000".repeat(124),
      " 1".repeat(250),
    ];
    for (const s of shapes) {
      for (const parse of PARSERS)
        expect(timed(() => parse(s))).toBeLessThan(50);
    }
  });

  // GLUED_PREFIX (/[a-z]+$/i) and COUNT_BEFORE are run on `source.slice(0,
  // start)` for EVERY number, so a letter run followed by many numbers costs
  // O(numbers x letters^2): 500 chars = ~35 ms, 4000 chars = ~12 s. Values
  // are capped at 500 chars, but one 10 KB cell (20 such options) on each of
  // the 6 filter columns of 2000 rows (one shared string) = hours of CPU.
  it.fails(
    "[Medium, T3] parses a letters-then-numbers value in near-linear time",
    () => {
      const s = "a".repeat(250) + " 1".repeat(125); // 500 chars, under the cap
      const total = timed(() => {
        for (let i = 0; i < 20; i++) for (const parse of PARSERS) parse(s);
      });
      // 20 options x 6 filters of one row must stay well under 100 ms.
      expect(total).toBeLessThan(100);
    },
  );
});

/* ------------------------------------------------------------------------ *
 * 5. Grouping
 * ------------------------------------------------------------------------ */

const row = (
  r: number,
  cells: Partial<Record<ColumnKey, string>>,
): SheetRow => ({
  sheet: "Sheet1",
  row: r,
  hidden: false,
  cells,
});

const CATEGORIES: CategoryLookup[] = [
  {
    id: "a".repeat(24),
    name: "Magnetic Track",
    slug: "magnetic-track",
    parentId: null,
  },
  { id: "b".repeat(24), name: "10mm", slug: "10mm", parentId: "a".repeat(24) },
  {
    id: "c".repeat(24),
    name: "Spot Lights",
    slug: "spot-lights",
    parentId: null,
  },
  { id: "d".repeat(24), name: "10mm", slug: "10mm", parentId: "c".repeat(24) },
];
const LOOKUPS = {
  categories: CATEGORIES,
  areas: [],
  defaultCategoryId: "c".repeat(24),
};
const group = (rows: SheetRow[]) => groupRows(rows.map(cleanRow), LOOKUPS);

describe("gate A: grouping", () => {
  it("blocks model nos. equal after case, full-width and invisible-character folding", () => {
    const { products } = group([
      row(3, { productNo: "1", modelNo: "AR-013A1" }),
      row(4, { productNo: "2", modelNo: "ａｒ-013ａ1" }),
      row(5, {
        productNo: "3",
        modelNo: "AR-0" + String.fromCodePoint(0x200b) + "13A1",
      }),
    ]);
    expect(products.map((p) => p.blocked)).toEqual([true, true, true]);
    expect(
      products.every((p) =>
        p.warnings.some((w) => w.code === "duplicate_model_no"),
      ),
    ).toBe(true);
  });

  it("never lets a Category cell name an id directly, a path outside the tree, or a 3-level path", () => {
    for (const cell of [
      "a".repeat(24),
      "../../etc",
      "Magnetic Track > 10mm > x",
      "{$ne:null}",
    ]) {
      const { products } = group([
        row(3, { productNo: "1", modelNo: "X-1", category: cell }),
      ]);
      const p = products[0];
      expect(p?.mainCategory).toBe("c".repeat(24));
      expect(p?.mainCategoryFromSheet).toBe(false);
      expect(p?.warnings.some((w) => w.code === "unknown_category")).toBe(true);
    }
  });

  it("sets trackSize only under Magnetic Track and calls an ambiguous bare name unknown", () => {
    const [track] = group([
      row(3, {
        productNo: "1",
        modelNo: "T-1",
        category: "Magnetic Track > 10mm",
      }),
    ]).products;
    expect(track?.trackSize).toBe(10);
    const [spot] = group([
      row(3, {
        productNo: "1",
        modelNo: "S-1",
        category: "Spot Lights > 10mm",
      }),
    ]).products;
    expect(spot?.trackSize).toBeNull();
    const [bare] = group([
      row(3, { productNo: "1", modelNo: "B-1", category: "10mm" }),
    ]).products;
    expect(bare?.mainCategoryFromSheet).toBe(false);
    expect(bare?.trackSize).toBeNull();
  });

  it("gives a URL-safe (or empty) slug candidate and bounded name/code for hostile cells", () => {
    const hostile = [
      ["../../<script>alert(1)</script>", "../../x/.."],
      ["白色", "白-1"],
      ["%2e%2e", "A/B?C#D"],
      ["", "-"],
    ];
    hostile.forEach(([family, modelNo], i) => {
      const { products } = group([
        row(3 + i, { productNo: String(i + 1), family, modelNo }),
      ]);
      const p = products[0];
      if (!p) throw new Error("no product");
      expect(p.slug === "" || SLUG_PATTERN.test(p.slug)).toBe(true);
      expect(Array.from(p.baseModelCode).length).toBeLessThanOrEqual(64);
      expect(hasCjk(p.name + p.slug + (p.family ?? "") + p.baseModelCode)).toBe(
        false,
      );
    });
  });

  it("reports an orphan row at file level and blocks a product with a missing model no.", () => {
    const result = group([
      row(3, { modelNo: "O-1" }),
      row(4, { productNo: "1", modelNo: "P-1" }),
      row(5, { family: "Arc" }),
    ]);
    expect(result.warnings.map((w) => w.code)).toContain("orphan_row");
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.blocked).toBe(true);
  });

  it("keeps CJK out of variant labels and warning details built from cell values", () => {
    const { products } = group([
      row(3, {
        productNo: "1",
        family: "Arc 弧",
        modelNo: "A-1",
        lens: "透镜 Regular Lens",
        cct: "暖白 3000K",
      }),
      row(4, {
        modelNo: "A-2",
        reflector: "反光杯\n\n反光杯",
        family: "Arc2 弧",
      }),
    ]);
    const p = products[0];
    if (!p) throw new Error("no product");
    for (const v of p.variants) expect(hasCjk(v.label)).toBe(false);
    for (const w of p.warnings) expect(hasCjk(w.detail ?? "")).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Restricted values (pins behaviour T7/T9 must account for)
 * ------------------------------------------------------------------------ */

describe("gate A: restricted columns", () => {
  it("filtersFromSpecs does not know about visibility (T7 must call withoutRestrictedFilters)", () => {
    // If the admin marks CCT restricted, this number must still be dropped in T7.
    expect(filtersFromSpecs([{ cct: ["3000K"] }])).toEqual({ cctK: [3000] });
  });

  it("unparsed_filter_value echoes the cell value (T9 must not log/persist it for restricted columns)", () => {
    const { products } = group([
      row(3, { productNo: "1", modelNo: "R-1", cct: "SECRET-WARM" }),
    ]);
    const w = products[0]?.warnings.find(
      (x) => x.code === "unparsed_filter_value",
    );
    expect(w?.detail).toContain("SECRET-WARM");
  });

  it("no warning of the synthetic client sheet repeats a default-restricted value", async () => {
    const read = await readWorkbook(await buildFixture());
    if (!read.ok) throw new Error("fixture unreadable");
    const cleaned = read.rows.map(cleanRow);
    const restricted = cleaned.flatMap((r) =>
      (
        ["batchNo", "chipType", "holder", "chipEfficiency", "driver"] as const
      ).flatMap((k) => r.specs[k] ?? []),
    );
    const { products, warnings } = groupRows(cleaned, LOOKUPS);
    const details = [...warnings, ...products.flatMap((p) => p.warnings)].map(
      (w) => w.detail ?? "",
    );
    for (const value of restricted) {
      for (const d of details) expect(d.includes(`"${value}"`)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 7. Resource bounds and the real sheet (local only)
 * ------------------------------------------------------------------------ */

describe("gate A: resource bounds", () => {
  it("runs check, read, clean and group on a 3000-row sheet in seconds", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow([
      "NO.",
      "Model Name",
      "Model No.",
      "CCT",
      "Wattage",
      "Beam Angle",
      "Driver",
    ]);
    for (let i = 0; i < 3000; i++) {
      ws.addRow([
        i % 2 === 0 ? i / 2 + 1 : null,
        "Arc",
        `AR-${i}`,
        "3000K\n4000K",
        "12W",
        "24°\n36°",
        "Lifud 莱福德",
      ]);
    }
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const start = performance.now();
    expect((await checkImportFile(bytes)).ok).toBe(true);
    const read = await readWorkbook(bytes);
    if (!read.ok) throw new Error("unreadable");
    const { products } = groupRows(read.rows.map(cleanRow), LOOKUPS);
    expect(products).toHaveLength(1500);
    expect(performance.now() - start).toBeLessThan(15_000);
  }, 60_000);
});

// A test-only path override; nothing secret (plan decision 1).
const REAL_SHEET =
  // eslint-disable-next-line no-restricted-properties
  process.env.IMPORT_FIXTURE ?? "doc/reference/client-sample-sheet.xlsx";

describe("gate A: real client sheet (local only, never committed)", () => {
  it("passes the safety check and leaves no CJK anywhere after grouping", async (ctx) => {
    const { existsSync, readFileSync } = await import("node:fs");
    if (!existsSync(REAL_SHEET)) {
      console.warn(`[gate A] real sheet missing at ${REAL_SHEET}: skipped`);
      ctx.skip();
      return;
    }
    const bytes = new Uint8Array(readFileSync(REAL_SHEET));
    expect((await checkImportFile(bytes)).ok).toBe(true);
    const read = await readWorkbook(bytes);
    if (!read.ok) throw new Error("unreadable");
    const { products } = groupRows(read.rows.map(cleanRow), LOOKUPS);
    const embedded = await readEmbeddedImages(
      bytes,
      read.sheets.map((s) => s.name),
    );
    const attached = attachImages(products, embedded);
    const text = JSON.stringify(
      attached.products.map((p) => ({ ...p, warnings: undefined })),
    );
    expect(hasCjk(text)).toBe(false);
    const arc = attached.products.find((p) => p.productNo === 76);
    expect(arc?.slug).toBe("arc-ar-013a");
    expect(arc?.variants.map((v) => v.modelNo)).toEqual([
      "AR-013A1",
      "AR-013A2",
    ]);
    expect(
      attached.products.filter((p) => p.blocked).map((p) => p.productNo),
    ).toEqual([80, 81]);
  }, 60_000);
});
