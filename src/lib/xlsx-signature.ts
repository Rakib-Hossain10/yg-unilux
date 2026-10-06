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

interface CentralEntry {
  name: string;
  flags: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

type Parsed =
  { ok: true; entries: CentralEntry[] } | { ok: false; reason: XlsxRejection };

/*
 * Reads the central directory: finds the End Of Central Directory record in
 * the last 64 KB, checks the entry count BEFORE walking the directory, then
 * reads each entry's name and declared size. Anything out of range = corrupt.
 */
function readCentralDirectory(bytes: Uint8Array): Parsed {
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

  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  // 0xFFFF / 0xFFFFFFFF mean "see the zip64 record": far beyond our cap.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    return { ok: false, reason: "too_many_entries" };
  }
  if (count > MAX_XLSX_ENTRIES)
    return { ok: false, reason: "too_many_entries" };
  if (offset + size > eocd) return { ok: false, reason: "corrupt" };

  const entries: CentralEntry[] = [];
  let at = offset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL_HEADER) {
      return { ok: false, reason: "corrupt" };
    }
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) return { ok: false, reason: "corrupt" };
    entries.push({
      name: new TextDecoder().decode(
        bytes.subarray(at + 46, at + 46 + nameLength),
      ),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      uncompressedSize: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at = end;
  }
  return { ok: true, entries };
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

  const parsed = readCentralDirectory(bytes);
  if (!parsed.ok) return parsed;

  const byName = new Map(parsed.entries.map((e) => [e.name, e]));
  for (const part of REQUIRED_PARTS) {
    if (!byName.has(part)) return { ok: false, reason: "not_xlsx" };
  }
  const types = byName.get("[Content_Types].xml");
  if (types === undefined) return { ok: false, reason: "not_xlsx" };

  const text = readPart(bytes, types);
  if (text === "corrupt") return { ok: false, reason: "corrupt" };
  if (text === null || !text.includes(WORKBOOK_CONTENT_TYPE)) {
    return { ok: false, reason: "not_xlsx" };
  }
  return { ok: true };
}

/*
 * The text of one small zip part. null = refused (encrypted, too big, an
 * unknown compression method); "corrupt" = the bytes do not match the
 * directory. Output is capped at MAX_XLSX_PART_BYTES while inflating.
 */
function readPart(bytes: Uint8Array, entry: CentralEntry): string | null {
  if ((entry.flags & 1) !== 0) return null; // encrypted
  if (entry.uncompressedSize > MAX_XLSX_PART_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (at + 30 > bytes.length || view.getUint32(at, true) !== LOCAL_HEADER) {
    return "corrupt";
  }
  const start =
    at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) return "corrupt";
  const data = bytes.subarray(start, end);
  try {
    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method !== 8) return null;
    return new TextDecoder().decode(
      inflateRawSync(data, { maxOutputLength: MAX_XLSX_PART_BYTES }),
    );
  } catch {
    // Damaged stream, or it inflated past the cap: either way not a workbook.
    return "corrupt";
  }
}
