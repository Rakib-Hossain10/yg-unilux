// Checks that a file is really an .xlsx workbook, by content and not by name
// (CLAUDE.md: "check file signature, not just extension"). Pure: bytes in,
// verdict out, so it runs on the server after a direct R2 upload.
//
// An .xlsx is a zip. We read the zip's central directory ourselves (cheap, no
// inflating) to count and name the entries, and only then let JSZip inflate
// the one small part that proves the type: [Content_Types].xml, with a hard
// output cap so a crafted deflate stream cannot fill memory.

import { inflateRawSync } from "node:zlib";

import {
  MAX_DATASHEET_BYTES,
  MAX_XLSX_ENTRIES,
  MAX_XLSX_PART_BYTES,
} from "./constants";

export type XlsxRejection =
  | "empty"
  | "too_large"
  | "not_zip"
  | "corrupt"
  | "too_many_entries"
  | "not_xlsx";

export type XlsxCheck = { ok: true } | { ok: false; reason: XlsxRejection };

/** Messages for the admin, one per reason. */
export const XLSX_REJECTED: Record<XlsxRejection, string> = {
  empty: "The file is empty.",
  too_large: `The file is larger than ${MAX_DATASHEET_BYTES / (1024 * 1024)} MB.`,
  not_zip: "This is not an Excel (.xlsx) file.",
  corrupt: "The file is damaged or incomplete. Upload it again.",
  too_many_entries: "This file has too many parts to be a normal workbook.",
  not_xlsx: "This is not an Excel (.xlsx) workbook.",
};

const REQUIRED_PARTS = ["[Content_Types].xml", "xl/workbook.xml"] as const;
/* The workbook's main part type; macro-enabled (.xlsm) uses another one. */
const WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

const LOCAL_HEADER = 0x04034b50; // "PK\x03\x04"
const EOCD = 0x06054b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** One entry of the zip's central directory: name and declared sizes. */
export interface CentralEntry {
  name: string;
  /** The raw name bytes, to compare with the local header's copy. */
  nameBytes: Uint8Array;
  /** Ids of the central-directory extra fields (e.g. 0x7075 Unicode Path). */
  extraFieldIds: number[];
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

/** Caps and rules the central-directory reader applies. */
export interface CentralDirectoryLimits {
  maxEntries: number;
  /*
   * What may sit between the directory and the end record:
   * - "none": nothing (the import, parsed by JSZip, which would read a gap
   *   as "extra bytes in front" and shift every offset);
   * - "zip64-trailer": nothing, or exactly a consistent zip64 end record +
   *   locator that some Open XML writers add (datasheets are stored, never
   *   parsed by JSZip on our server).
   */
  trailer: "none" | "zip64-trailer";
}

export type CentralDirectory =
  | {
      ok: true;
      entries: CentralEntry[];
      /** Where the directory starts; every entry's data must end before it. */
      directoryOffset: number;
    }
  | { ok: false; reason: "corrupt" | "too_many_entries" };

/**
 * Reads the central directory: finds the End Of Central Directory record in
 * the last 64 KB, checks the entry count against `limits.maxEntries` BEFORE
 * walking the directory, then reads each entry's name and declared sizes.
 * Nothing is inflated. Anything out of range = corrupt. Shared by the
 * datasheet check (below) and the import safety check (ADR 0047).
 */
export function readCentralDirectory(
  bytes: Uint8Array,
  limits: CentralDirectoryLimits,
): CentralDirectory {
  if (bytes.length < EOCD_MIN) return { ok: false, reason: "corrupt" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lowest = Math.max(0, bytes.length - EOCD_MIN - MAX_COMMENT);
  let eocd = -1;
  for (let i = bytes.length - EOCD_MIN; i >= lowest; i--) {
    if (view.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return { ok: false, reason: "corrupt" };

  const diskNumber = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const countOnDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  // 0xFFFF / 0xFFFFFFFF mean "see the zip64 record": far beyond our cap.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    return { ok: false, reason: "too_many_entries" };
  }
  if (count > limits.maxEntries)
    return { ok: false, reason: "too_many_entries" };
  // One disk only. JSZip also switches to a zip64 directory it SEARCHES for
  // when any disk field is 0xFFFF, so these must be plain zeros.
  if (diskNumber !== 0 || directoryDisk !== 0 || countOnDisk !== count) {
    return { ok: false, reason: "corrupt" };
  }
  // The end record's comment must reach exactly to the end of the file, so
  // no other bytes trail the record we picked.
  if (eocd + EOCD_MIN + view.getUint16(eocd + 20, true) !== bytes.length) {
    return { ok: false, reason: "corrupt" };
  }
  // The directory must end where the end record starts (or, for datasheets,
  // at a valid zip64 trailer just before it). Any other gap is how a decoy
  // zip in front of a bomb makes two readers see two different directories.
  const directoryEnd = offset + size;
  const gapAllowed =
    directoryEnd === eocd ||
    (limits.trailer === "zip64-trailer" &&
      isZip64Trailer(view, directoryEnd, eocd, offset, size));
  if (!gapAllowed) return { ok: false, reason: "corrupt" };

  const entries: CentralEntry[] = [];
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > directoryEnd || view.getUint32(at, true) !== CENTRAL_HEADER) {
      return { ok: false, reason: "corrupt" };
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > directoryEnd) return { ok: false, reason: "corrupt" };
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const extraFieldIds = readExtraFieldIds(
      view,
      at + 46 + nameLength,
      extraLength,
    );
    if (extraFieldIds === null) return { ok: false, reason: "corrupt" };
    entries.push({
      name: new TextDecoder().decode(nameBytes),
      nameBytes,
      extraFieldIds,
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at = end;
  }
  // JSZip keeps reading headers while the signature matches, whatever the
  // count says; so the counted entries must fill the directory exactly.
  if (at !== directoryEnd) return { ok: false, reason: "corrupt" };
  return { ok: true, entries, directoryOffset: offset };
}

/* The ids of an entry's extra fields; null when the block is malformed. */
function readExtraFieldIds(
  view: DataView,
  start: number,
  length: number,
): number[] | null {
  const ids: number[] = [];
  let at = start;
  const end = start + length;
  while (at < end) {
    if (at + 4 > end) return null;
    ids.push(view.getUint16(at, true));
    at += 4 + view.getUint16(at + 2, true);
  }
  return at === end ? ids : null;
}

const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_TRAILER_BYTES = 56 + 20;

/*
 * Exactly a zip64 end record (56 bytes) + locator (20 bytes) between the
 * directory and the end record, both pointing at the same directory as the
 * 32-bit fields. Anything else in that gap is refused.
 */
function isZip64Trailer(
  view: DataView,
  record: number,
  eocd: number,
  offset: number,
  size: number,
): boolean {
  if (eocd - record !== ZIP64_TRAILER_BYTES) return false;
  const locator = eocd - 20;
  return (
    view.getUint32(record, true) === ZIP64_EOCD &&
    view.getBigUint64(record + 4, true) === BigInt(44) &&
    view.getBigUint64(record + 40, true) === BigInt(size) &&
    view.getBigUint64(record + 48, true) === BigInt(offset) &&
    view.getUint32(locator, true) === ZIP64_LOCATOR &&
    view.getBigUint64(locator + 8, true) === BigInt(record)
  );
}

/**
 * Is this byte array a plausible .xlsx workbook? Checks, in order: not empty,
 * at most MAX_DATASHEET_BYTES, zip magic at offset 0, a readable central
 * directory with at most MAX_XLSX_ENTRIES entries, both required parts
 * present, and a [Content_Types].xml that declares a spreadsheet workbook.
 * Never inflates anything but that one small part.
 */
export async function checkXlsx(bytes: Uint8Array): Promise<XlsxCheck> {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  if (bytes.length > MAX_DATASHEET_BYTES)
    return { ok: false, reason: "too_large" };
  if (
    bytes.length < EOCD_MIN ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) !== LOCAL_HEADER
  ) {
    return { ok: false, reason: "not_zip" };
  }

  const parsed = readCentralDirectory(bytes, {
    maxEntries: MAX_XLSX_ENTRIES,
    trailer: "zip64-trailer",
  });
  if (!parsed.ok) return parsed;

  const byName = new Map(parsed.entries.map((e) => [e.name, e]));
  for (const part of REQUIRED_PARTS) {
    if (!byName.has(part)) return { ok: false, reason: "not_xlsx" };
  }
  const types = byName.get("[Content_Types].xml");
  if (types === undefined) return { ok: false, reason: "not_xlsx" };

  const text = readZipPart(bytes, types, MAX_XLSX_PART_BYTES);
  if (text === "corrupt") return { ok: false, reason: "corrupt" };
  if (text === null || !text.includes(WORKBOOK_CONTENT_TYPE)) {
    return { ok: false, reason: "not_xlsx" };
  }
  return { ok: true };
}

/** Does the byte array start with a zip local-file header ("PK\x03\x04")? */
export function hasZipMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      0,
      true,
    ) === LOCAL_HEADER
  );
}

/**
 * The compressed bytes of one entry, located through its local header.
 * "corrupt" = the local header or the data lies outside the file.
 */
export function entryData(
  bytes: Uint8Array,
  entry: CentralEntry,
): Uint8Array | "corrupt" {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_HEADER) {
    return "corrupt";
  }
  const start =
    at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) return "corrupt";
  return bytes.subarray(start, end);
}

/**
 * The text of one small zip part. null = refused (encrypted, larger than
 * `maxBytes`, an unknown compression method); "corrupt" = the bytes do not
 * match the directory. Output is capped at `maxBytes` while inflating.
 */
export function readZipPart(
  bytes: Uint8Array,
  entry: CentralEntry,
  maxBytes: number,
): string | null {
  const data = readZipBytes(bytes, entry, maxBytes);
  if (data === null || data === "corrupt") return data;
  return new TextDecoder().decode(data);
}

/**
 * The bytes of one zip part (e.g. an embedded picture), with the same rules
 * as `readZipPart`: null = refused (encrypted, declared larger than
 * `maxBytes`, unknown method); "corrupt" = the data does not match the
 * directory. Output is capped at `maxBytes` while inflating, and must equal
 * the declared size. A stored part is returned as a view into `bytes`
 * (no copy): never write to the result.
 */
export function readZipBytes(
  bytes: Uint8Array,
  entry: CentralEntry,
  maxBytes: number,
): Uint8Array | null | "corrupt" {
  if ((entry.flags & 1) !== 0) return null; // encrypted
  if (entry.uncompressedSize > maxBytes) return null;
  const data = entryData(bytes, entry);
  if (data === "corrupt") return "corrupt";
  try {
    if (entry.method === 0) {
      // Stored: the bytes ARE the part, so they must match the declared size.
      if (data.length !== entry.uncompressedSize) return "corrupt";
      return data;
    }
    if (entry.method !== 8) return null;
    const out = inflateRawSync(data, { maxOutputLength: maxBytes });
    if (out.length !== entry.uncompressedSize) return "corrupt";
    return out;
  } catch {
    // Damaged stream, or it inflated past the cap: either way not a workbook.
    return "corrupt";
  }
}
