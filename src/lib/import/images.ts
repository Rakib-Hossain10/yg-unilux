// Image stage of the import (Phase 3 T5): finds the pictures embedded in the
// client's sheet, checks them, and gives each product its gallery. Analysis
// only: nothing is uploaded here (Cloudinary uploads happen at commit, T8).
//
// Pictures are read the standard way: workbook → sheet part → its drawing
// (xl/drawings/drawingN.xml) → each oneCell/twoCell anchor's top-left cell →
// the picture part (xl/media/*) through the drawing's relationships. Parts
// are read with the shared zip reader (src/lib/xlsx-signature.ts) and its
// capped inflate, from the CheckedImportFile safety.ts made (the only input
// accepted, so an unchecked upload never reaches this reader). Other
// picture stores (WPS cell images, Excel "Place in Cell") are reported, not
// guessed at. Linked pictures are never fetched.

import "server-only";

import { createHash } from "node:crypto";

import sharp from "sharp";

import {
  MAX_IMAGE_BYTES,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_IMAGE_PIXELS,
  MAX_IMPORT_XML_PART_BYTES,
  MAX_PRODUCT_IMAGES,
} from "@/lib/constants";
import {
  readCentralDirectory,
  readZipBytes,
  readZipPart,
  type CentralEntry,
} from "@/lib/xlsx-signature";

import {
  childNamed,
  childrenNamed,
  descendantsNamed,
  parseXml,
  readRelationships,
  relsPathFor,
  type Relationship,
  type XmlElement,
} from "./ooxml";
import { isCheckedImportFile, type CheckedImportFile } from "./safety";
import {
  importWarning,
  type ImportImage,
  type ImportImageFormat,
  type ImportImageRef,
  type ImportProduct,
  type ImportWarning,
} from "./types";

/** A distinct picture with its bytes, for the commit step's upload (T8). */
export interface EmbeddedImage extends ImportImage {
  data: Uint8Array;
}

/** One picture placed on a sheet. */
export interface ImageAnchor {
  sheet: string;
  /** Excel row (1-based) of the anchor's top-left cell; null = not on a cell. */
  row: number | null;
  /** Excel column (1-based, A = 1) of the top-left cell; null = not on a cell. */
  column: number | null;
  /** The picture (key of `files`), or null when it cannot be used. */
  sha256: string | null;
  /** Why the picture cannot be used (unsupported_image / image_too_large). */
  issue: ImportWarning | null;
}

export interface EmbeddedImages {
  /** In the given sheet order, then row, column and drawing order. */
  anchors: ImageAnchor[];
  /**
   * Every usable picture referenced by an anchor, once, by sha256. Holds the
   * bytes: never hash or serialise it. Upload only what `product.images`
   * references (a picture on no product's row is here but not used).
   */
  files: ReadonlyMap<string, EmbeddedImage>;
  /** Findings about the whole file or a whole sheet. */
  warnings: ImportWarning[];
}

const RELATIONSHIP_DRAWING = /\/relationships\/drawing$/;
const RELATIONSHIP_WORKSHEET = /\/relationships\/worksheet$/;

/* Excel's grid: 1,048,576 rows × 16,384 columns. */
const MAX_ROW_INDEX = 1_048_575;
const MAX_COL_INDEX = 16_383;

/* Formats the site accepts from the sheet (sharp's names), and how we name them. */
const ACCEPTED: ReadonlySet<string> = new Set<ImportImageFormat>([
  "jpeg",
  "png",
  "webp",
]);
const MB = 1024 * 1024;

/**
 * Reads every picture anchored on the given sheets (the names `readWorkbook`
 * read). Never throws for bad content: unreadable parts become warnings.
 */
export async function readEmbeddedImages(
  file: CheckedImportFile,
  sheetNames: readonly string[],
): Promise<EmbeddedImages> {
  if (!isCheckedImportFile(file)) {
    throw new TypeError("readEmbeddedImages: run checkImportFile first");
  }
  const { bytes } = file;
  const warnings: ImportWarning[] = [];
  const anchors: ImageAnchor[] = [];
  const files = new Map<string, EmbeddedImage>();

  const directory = readCentralDirectory(bytes, {
    maxEntries: MAX_IMPORT_ENTRIES,
    trailer: "none",
  });
  if (!directory.ok) {
    warnings.push(storeWarning(null, "The pictures could not be read."));
    return { anchors, files, warnings };
  }
  const pkg = new Package(bytes, directory.entries);
  warnings.push(...otherStores(pkg));

  const sheetParts = sheetPartsByName(pkg);
  const pictures = new PictureCache(pkg, files);
  for (const sheet of sheetNames) {
    const sheetPart = sheetParts?.get(sheet);
    if (sheetPart === undefined) {
      if (sheetParts === null) continue; // reported once below
      warnings.push(
        storeWarning(
          sheet,
          `The pictures of sheet "${sheet}" could not be found.`,
        ),
      );
      continue;
    }
    const sheetAnchors = await readSheetAnchors(
      pkg,
      sheet,
      sheetPart,
      pictures,
    );
    if (sheetAnchors === null) {
      warnings.push(
        storeWarning(
          sheet,
          `The pictures of sheet "${sheet}" could not be read. Save the file again in Excel and re-upload, or add the images in the admin after import.`,
        ),
      );
      continue;
    }
    anchors.push(...sheetAnchors);
  }
  if (sheetParts === null && sheetNames.length > 0) {
    warnings.push(storeWarning(null, "The pictures could not be read."));
  }
  return { anchors, files, warnings };
}

/* ------------------------------------------------------------------------ *
 * Package access.
 * ------------------------------------------------------------------------ */

/* Part lookup by name; Open XML part names compare case-insensitively. */
class Package {
  private readonly byName = new Map<string, CentralEntry>();

  constructor(
    private readonly bytes: Uint8Array,
    entries: readonly CentralEntry[],
  ) {
    for (const entry of entries) {
      if (entry.name.endsWith("/")) continue;
      const key = entry.name.replace(/^\/+/, "").toLowerCase();
      if (!this.byName.has(key)) this.byName.set(key, entry);
    }
  }

  names(): IterableIterator<string> {
    return this.byName.keys();
  }

  entry(name: string): CentralEntry | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** A parsed XML part; null when missing, too large, corrupt or malformed. */
  xml(name: string): XmlElement | null {
    const entry = this.entry(name);
    if (entry === undefined) return null;
    const text = readZipPart(this.bytes, entry, MAX_IMPORT_XML_PART_BYTES);
    if (text === null || text === "corrupt") return null;
    return parseXml(text);
  }

  /** A part's relationships; an absent .rels file means none. */
  relationships(part: string): Map<string, Relationship> | null {
    const relsPath = relsPathFor(part);
    if (this.entry(relsPath) === undefined) return new Map();
    const rels = this.xml(relsPath);
    return rels === null ? null : readRelationships(rels, part);
  }

  binary(entry: CentralEntry, maxBytes: number): Uint8Array | null {
    const data = readZipBytes(this.bytes, entry, maxBytes);
    return data === null || data === "corrupt" ? null : data;
  }
}

/*
 * WPS "cell images" (DISPIMG formulas backed by xl/cellimages.xml) and Excel
 * "Place in Cell" pictures are not anchored on the sheet, so we do not read
 * them: each store present gives one warning. Excel keeps in-cell pictures
 * in xl/richData/richValueRel.xml (local images) or rdRichValueWebImage.xml
 * (web images); other richData parts belong to data types (Stocks,
 * Geography) and are not pictures.
 */
const RICH_DATA_IMAGE_PARTS: ReadonlySet<string> = new Set([
  "xl/richdata/richvaluerel.xml",
  "xl/richdata/rdrichvaluewebimage.xml",
]);

function otherStores(pkg: Package): ImportWarning[] {
  const names = [...pkg.names()];
  const found: ImportWarning[] = [];
  if (names.some((n) => n === "xl/cellimages.xml")) {
    found.push(
      storeWarning(
        null,
        "This file also has pictures placed inside cells (WPS cell images). Those are not imported: make them floating pictures over the Image cell, or add them in the admin after import.",
      ),
    );
  }
  if (names.some((n) => RICH_DATA_IMAGE_PARTS.has(n))) {
    found.push(
      storeWarning(
        null,
        'This file has pictures placed in cells (Excel "Place in Cell"). Those are not imported: use "Place over Cells" instead, or add them in the admin after import.',
      ),
    );
  }
  return found;
}

function storeWarning(sheet: string | null, detail: string): ImportWarning {
  return importWarning("unsupported_image_store", { sheet, detail });
}

/* Sheet name → its worksheet part path, from the workbook and its rels. */
function sheetPartsByName(pkg: Package): Map<string, string> | null {
  const workbook = pkg.xml("xl/workbook.xml");
  const rels = pkg.relationships("xl/workbook.xml");
  if (workbook === null || rels === null) return null;
  const parts = new Map<string, string>();
  const sheets = childNamed(workbook, "sheets");
  for (const sheet of sheets ? childrenNamed(sheets, "sheet") : []) {
    const name = sheet.attrs.name;
    const id = sheet.attrs.id; // r:id (prefix dropped)
    const rel = id === undefined ? undefined : rels.get(id);
    if (name === undefined || rel === undefined || rel.external) continue;
    if (!RELATIONSHIP_WORKSHEET.test(rel.type)) continue;
    if (!parts.has(name)) parts.set(name, rel.target);
  }
  return parts;
}

/* ------------------------------------------------------------------------ *
 * Drawings and anchors.
 * ------------------------------------------------------------------------ */

interface RawAnchor {
  row: number | null;
  column: number | null;
  /** Drawing relationship id of the picture, or a reason it has none. */
  embed: string | null;
  linked: boolean;
}

/* Every picture anchor of one sheet, sorted; null = a drawing is unreadable. */
async function readSheetAnchors(
  pkg: Package,
  sheet: string,
  sheetPart: string,
  pictures: PictureCache,
): Promise<ImageAnchor[] | null> {
  const sheetRels = pkg.relationships(sheetPart);
  if (sheetRels === null) return null;
  // Every drawing is parsed before any picture is read, so an unreadable
  // drawing never leaves pictures in `files` that no anchor references.
  const drawings: { anchors: RawAnchor[]; rels: Map<string, Relationship> }[] =
    [];
  for (const rel of sheetRels.values()) {
    if (rel.external || !RELATIONSHIP_DRAWING.test(rel.type)) continue;
    const drawing = pkg.xml(rel.target);
    const drawingRels = pkg.relationships(rel.target);
    if (drawing === null || drawingRels === null) return null;
    drawings.push({ anchors: drawingAnchors(drawing), rels: drawingRels });
  }
  const anchors: (ImageAnchor & { order: number })[] = [];
  for (const { anchors: raws, rels: drawingRels } of drawings) {
    for (const raw of raws) {
      const picture = await resolvePicture(raw, drawingRels, pictures);
      const where = { sheet, row: raw.row, column: raw.column };
      anchors.push({
        ...where,
        sha256: picture.sha256,
        issue:
          picture.problem === null
            ? null
            : importWarning(picture.problem.code, {
                sheet,
                ...(raw.row === null ? {} : { row: raw.row }),
                column: "image",
                detail: `${cellName(raw)}: ${picture.problem.detail}`,
              }),
        order: anchors.length,
      });
    }
  }
  anchors.sort(
    (a, b) =>
      (a.row ?? Infinity) - (b.row ?? Infinity) ||
      (a.column ?? Infinity) - (b.column ?? Infinity) ||
      a.order - b.order,
  );
  return anchors.map(({ sheet: name, row, column, sha256, issue }) => ({
    sheet: name,
    row,
    column,
    sha256,
    issue,
  }));
}

/*
 * The anchors of a drawing (`xdr:wsDr`), each picture once. A group shape
 * yields each of its pictures at the group's anchor. Inside
 * `mc:AlternateContent`, only the first branch that holds anchors is read
 * (the others are fallbacks of the same content). Shapes, charts and other
 * non-picture objects are ignored.
 */
function drawingAnchors(drawing: XmlElement): RawAnchor[] {
  const out: RawAnchor[] = [];
  const visit = (elements: readonly XmlElement[]) => {
    for (const el of elements) {
      if (el.name === "AlternateContent") {
        const branch = el.children.find((b) =>
          b.children.some((c) => c.name.endsWith("Anchor")),
        );
        if (branch !== undefined) visit(branch.children);
        continue;
      }
      if (
        el.name !== "oneCellAnchor" &&
        el.name !== "twoCellAnchor" &&
        el.name !== "absoluteAnchor"
      ) {
        continue;
      }
      const cell = el.name === "absoluteAnchor" ? null : fromCell(el);
      for (const pic of picturesIn(el)) {
        const blip = descendantsNamed(pic, "blip")[0];
        const embed = blip?.attrs.embed ?? null;
        out.push({
          row: cell?.row ?? null,
          column: cell?.column ?? null,
          embed,
          linked: embed === null && blip?.attrs.link !== undefined,
        });
      }
    }
  };
  visit(drawing.children);
  return out;
}

/*
 * The `pic` elements under an anchor (several in a group shape). Inside an
 * `mc:AlternateContent`, only the first branch holding a picture counts, so
 * a Choice and its Fallback never yield the same placed picture twice.
 */
function picturesIn(el: XmlElement): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlElement) => {
    for (const child of node.children) {
      if (child.name === "pic") {
        found.push(child);
      } else if (child.name === "AlternateContent") {
        const branch = child.children.find(
          (b) => descendantsNamed(b, "pic").length > 0,
        );
        if (branch !== undefined) visit(branch);
      } else {
        visit(child);
      }
    }
  };
  visit(el);
  return found;
}

/* The anchor's `from` cell as Excel row/column numbers; null if invalid. */
function fromCell(anchor: XmlElement): { row: number; column: number } | null {
  const from = childNamed(anchor, "from");
  if (from === undefined) return null;
  const row = gridIndex(childNamed(from, "row")?.text, MAX_ROW_INDEX);
  const col = gridIndex(childNamed(from, "col")?.text, MAX_COL_INDEX);
  if (row === null || col === null) return null;
  // Anchors are 0-based; the pipeline uses Excel's 1-based numbers.
  return { row: row + 1, column: col + 1 };
}

function gridIndex(text: string | undefined, max: number): number | null {
  const trimmed = text?.trim() ?? "";
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= max ? value : null;
}

/** 1 → "A", 27 → "AA". */
function columnLetter(column: number): string {
  let n = column;
  let letters = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellName(at: { row: number | null; column: number | null }): string {
  if (at.row === null || at.column === null)
    return "A picture not placed on a cell";
  return `The picture at ${columnLetter(at.column)}${at.row}`;
}

/* ------------------------------------------------------------------------ *
 * Pictures.
 * ------------------------------------------------------------------------ */

interface PictureProblem {
  code: "unsupported_image" | "image_too_large";
  detail: string;
}

interface PictureResult {
  sha256: string | null;
  problem: PictureProblem | null;
}

function resolvePicture(
  raw: RawAnchor,
  rels: ReadonlyMap<string, Relationship>,
  pictures: PictureCache,
): Promise<PictureResult> | PictureResult {
  const rel = raw.embed === null ? undefined : rels.get(raw.embed);
  if (raw.linked || rel?.external === true) {
    return unusable(
      "unsupported_image",
      "is linked to a file outside the workbook, not embedded in it. Insert the picture itself, or add it in the admin after import.",
    );
  }
  if (rel === undefined) {
    return unusable(
      "unsupported_image",
      "could not be found in the file. Insert it again, or add it in the admin after import.",
    );
  }
  return pictures.get(rel.target);
}

function unusable(code: PictureProblem["code"], detail: string): PictureResult {
  return { sha256: null, problem: { code, detail } };
}

/* Checks each picture part once, however many anchors share it. */
class PictureCache {
  private readonly byPart = new Map<string, Promise<PictureResult>>();

  constructor(
    private readonly pkg: Package,
    private readonly files: Map<string, EmbeddedImage>,
  ) {}

  get(part: string): Promise<PictureResult> {
    const key = part.toLowerCase();
    let result = this.byPart.get(key);
    if (result === undefined) {
      result = this.load(part);
      this.byPart.set(key, result);
    }
    return result;
  }

  private async load(part: string): Promise<PictureResult> {
    const entry = this.pkg.entry(part);
    if (entry === undefined) {
      return unusable(
        "unsupported_image",
        "could not be found in the file. Insert it again, or add it in the admin after import.",
      );
    }
    // The directory's sizes were verified by safety.ts: refuse before inflating.
    if (entry.uncompressedSize > MAX_IMAGE_BYTES) {
      return unusable(
        "image_too_large",
        `is larger than ${MAX_IMAGE_BYTES / MB} MB. Use a smaller picture, or add it in the admin after import.`,
      );
    }
    const data = this.pkg.binary(entry, MAX_IMAGE_BYTES);
    if (data === null) return unreadable();
    const checked = await checkPicture(data);
    if ("problem" in checked) return { sha256: null, problem: checked.problem };

    const sha256 = createHash("sha256").update(data).digest("hex");
    if (!this.files.has(sha256)) {
      // A copy: a stored part is a view into the whole upload, and a small
      // inflated Buffer may sit in a shared pool. Each picture owns its bytes.
      this.files.set(sha256, {
        sha256,
        ...checked.image,
        data: new Uint8Array(data),
      });
    }
    return { sha256, problem: null };
  }
}

function unreadable(): PictureResult {
  return unusable(
    "unsupported_image",
    "could not be read. Insert it again as a JPEG or PNG, or add it in the admin after import.",
  );
}

/*
 * Format by magic bytes first: only JPEG, PNG and WebP ever reach sharp, so
 * EMF/WMF/SVG/TIFF/... are never parsed. sharp then reads the header only
 * (metadata never decodes pixels) to confirm the format and get the size.
 */
async function checkPicture(
  data: Uint8Array,
): Promise<
  { image: Omit<ImportImage, "sha256"> } | { problem: PictureProblem }
> {
  const sniffed = sniffFormat(data);
  if (!ACCEPTED.has(sniffed)) {
    return {
      problem: {
        code: "unsupported_image",
        detail: `is ${sniffed === "unknown" ? "in an unknown format" : `a${/^[AEIOU]/.test(sniffed) ? "n" : ""} ${sniffed} picture`}; only JPEG, PNG and WebP can be imported. Save it as PNG or JPEG and insert it again, or add it in the admin after import.`,
      },
    };
  }
  let format: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(data, {
      limitInputPixels: MAX_IMPORT_IMAGE_PIXELS,
    }).metadata();
    format = meta.format;
    // As displayed: EXIF orientations 5-8 swap width and height.
    width = meta.autoOrient?.width ?? meta.width;
    height = meta.autoOrient?.height ?? meta.height;
  } catch (error) {
    if (error instanceof Error && /pixel limit/i.test(error.message)) {
      return { problem: tooManyPixels() };
    }
    return { problem: unreadable().problem as PictureProblem };
  }
  if (
    format !== sniffed ||
    width === undefined ||
    height === undefined ||
    width < 1 ||
    height < 1
  ) {
    return { problem: unreadable().problem as PictureProblem };
  }
  if (width * height > MAX_IMPORT_IMAGE_PIXELS) {
    return { problem: tooManyPixels() };
  }
  return {
    image: {
      format: format as ImportImageFormat,
      width,
      height,
      bytes: data.length,
    },
  };
}

function tooManyPixels(): PictureProblem {
  return {
    code: "image_too_large",
    detail: `has more than ${MAX_IMPORT_IMAGE_PIXELS / 1_000_000} megapixels. Use a smaller picture, or add it in the admin after import.`,
  };
}

/* sharp's name for the accepted formats; a readable label for the rest. */
function sniffFormat(d: Uint8Array): string {
  const at = (i: number, ...values: number[]) =>
    values.every((v, k) => d[i + k] === v);
  const ascii = (i: number, text: string) =>
    at(i, ...Array.from(text, (c) => c.charCodeAt(0)));
  if (at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  if (ascii(0, "GIF8")) return "GIF";
  if (at(0, 0x01, 0x00, 0x00, 0x00) && ascii(40, " EMF")) return "EMF";
  if (
    at(0, 0xd7, 0xcd, 0xc6, 0x9a) ||
    at(0, 0x01, 0x00, 0x09, 0x00) ||
    at(0, 0x02, 0x00, 0x09, 0x00)
  ) {
    return "WMF";
  }
  if (ascii(0, "BM")) return "BMP";
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a))
    return "TIFF";
  if (ascii(4, "ftyp")) return "HEIF/AVIF";
  return "unknown";
}

/* ------------------------------------------------------------------------ *
 * Per product.
 * ------------------------------------------------------------------------ */

export interface AttachResult {
  /** Copies of the input products with `images`, variant pictures and warnings. */
  products: ImportProduct[];
  /** The file's image warnings plus pictures on rows of no product. */
  warnings: ImportWarning[];
}

/**
 * Gives each product its pictures (pure; inputs are not mutated):
 * - gallery = the distinct pictures (by sha256) on the product's rows, in
 *   anchor order (row, then column), capped at MAX_PRODUCT_IMAGES. A picture
 *   shared by two products is in BOTH galleries;
 * - variant picture = the first picture on the variant's row, set on every
 *   variant that has one, but only when the product's variants do not all
 *   lead with the same picture;
 * - `missing_image` (warning) when the gallery ends up empty; a picture that
 *   cannot be used is reported on its row. Nothing here blocks a product.
 */
export function attachImages(
  products: readonly ImportProduct[],
  embedded: EmbeddedImages,
): AttachResult {
  const warnings = [...embedded.warnings];
  const owner = new Map<string, number>();
  products.forEach((product, index) => {
    for (const row of product.rows)
      owner.set(rowKey(product.sheet, row), index);
  });

  const perProduct = products.map(() => [] as ImageAnchor[]);
  for (const anchor of embedded.anchors) {
    const index =
      anchor.row === null
        ? undefined
        : owner.get(rowKey(anchor.sheet, anchor.row));
    if (index === undefined) {
      warnings.push(notOnRow(anchor));
      continue;
    }
    (perProduct[index] as ImageAnchor[]).push(anchor);
  }

  return {
    products: products.map((product, index) =>
      withImages(product, perProduct[index] as ImageAnchor[]),
    ),
    warnings,
  };
}

function withImages(
  product: ImportProduct,
  anchors: readonly ImageAnchor[],
): ImportProduct {
  const added: ImportWarning[] = [];
  const gallery: ImportImageRef[] = [];
  const seen = new Set<string>();
  const leadByRow = new Map<number, string>();
  let dropped = 0;
  let unusable = 0;

  for (const anchor of anchors) {
    const row = anchor.row as number; // owned anchors always have a row
    if (anchor.sha256 === null) {
      unusable += 1;
      if (anchor.issue !== null) added.push(anchor.issue);
      continue;
    }
    if (!leadByRow.has(row)) leadByRow.set(row, anchor.sha256);
    if (seen.has(anchor.sha256)) continue;
    seen.add(anchor.sha256);
    if (gallery.length >= MAX_PRODUCT_IMAGES) {
      dropped += 1;
      continue;
    }
    gallery.push({ sha256: anchor.sha256, sheet: anchor.sheet, row });
  }

  const firstRow = product.rows[0] as number;
  if (dropped > 0) {
    added.push(
      importWarning("value_truncated", {
        sheet: product.sheet,
        row: firstRow,
        column: "image",
        detail: `This product has more than ${MAX_PRODUCT_IMAGES} different pictures; only the first ${MAX_PRODUCT_IMAGES} are imported.`,
      }),
    );
  }
  if (gallery.length === 0) {
    added.push(
      importWarning("missing_image", {
        sheet: product.sheet,
        row: firstRow,
        column: "image",
        detail:
          unusable > 0
            ? "None of this product's pictures can be used (see the warnings above). Add images in the admin after import."
            : "This product has no picture in the sheet. Add images in the admin after import.",
      }),
    );
  }

  const inGallery = new Set(gallery.map((ref) => ref.sha256));
  const leads = product.variants
    .map((v) => leadByRow.get(v.row))
    .filter((s): s is string => s !== undefined);
  const differ = new Set(leads).size > 1;

  return {
    ...product,
    images: gallery,
    variants: product.variants.map((variant) => {
      const lead = leadByRow.get(variant.row);
      return {
        ...variant,
        imageSha256:
          differ && lead !== undefined && inGallery.has(lead) ? lead : null,
      };
    }),
    warnings: [...product.warnings, ...added],
  };
}

function notOnRow(anchor: ImageAnchor): ImportWarning {
  if (anchor.row === null) {
    return importWarning("image_not_on_row", {
      sheet: anchor.sheet,
      column: "image",
      detail:
        "A picture floats freely instead of being anchored to a cell, so it belongs to no product. Anchor it to the product's Image cell, or add it in the admin after import.",
    });
  }
  return importWarning("image_not_on_row", {
    sheet: anchor.sheet,
    row: anchor.row,
    column: "image",
    detail: `${cellName(anchor)} is on a row that belongs to no product, so it is not imported.`,
  });
}

function rowKey(sheet: string, row: number): string {
  return `${sheet}\u0000${row}`;
}
