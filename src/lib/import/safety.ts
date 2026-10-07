// Pre-check for an uploaded import file, run BEFORE exceljs inflates anything
// (the upload is untrusted). Pure: bytes in, verdict out; no I/O beyond a
// counting inflate in memory.
//
// exceljs hands the file to JSZip, which inflates every entry fully into
// memory and only then compares the size with the directory. So this check
// (1) caps the file, the entry count, the total declared size and the
// per-entry ratio on the zip's central directory, (2) refuses overlapping
// entries (the reused-kernel bomb), (3) proves it is a real .xlsx and not a
// macro workbook, and (4) inflates every entry while COUNTING only, stopping
// at its declared size, so a directory that lies about sizes is caught with
// O(chunk) memory instead of after the damage.

import { createInflateRaw } from "node:zlib";

import {
  IMPORT_RATIO_MIN_BYTES,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COMPRESSION_RATIO,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_UNCOMPRESSED_BYTES,
  MAX_XLSX_PART_BYTES,
} from "@/lib/constants";
import {
  entryData,
  hasZipMagic,
  readCentralDirectory,
  readZipPart,
  type CentralEntry,
} from "@/lib/xlsx-signature";

import { importWarning, type ImportWarning } from "./types";

/** One reason per refusal, so the admin message says exactly what is wrong. */
export type ImportSafetyRejection =
  | "empty"
  | "too_large"
  | "not_zip"
  | "corrupt"
  | "not_xlsx"
  | "macro_enabled"
  | "unsupported_entry"
  | "too_many_entries"
  | "uncompressed_too_large"
  | "compression_ratio"
  | "size_mismatch"
  | "overlapping_entries"
  | "inconsistent_entries";

export type ImportSafetyResult =
  | { ok: true; entryNames: string[] }
  | { ok: false; reason: ImportSafetyRejection };

const MB = 1024 * 1024;

/** Messages for the admin, one per reason. */
export const IMPORT_SAFETY_MESSAGES: Record<ImportSafetyRejection, string> = {
  empty: "The file is empty.",
  too_large: `The file is larger than ${MAX_IMPORT_BYTES / MB} MB.`,
  not_zip: "This is not an Excel (.xlsx) file.",
  corrupt:
    "The file is damaged or incomplete. Save it again in Excel and re-upload.",
  not_xlsx: "This is not an Excel (.xlsx) workbook.",
  macro_enabled:
    "Macro-enabled workbooks (.xlsm) are not accepted. Save the sheet as .xlsx.",
  unsupported_entry:
    "The file is encrypted or uses an unsupported compression. Save it again as a plain .xlsx.",
  too_many_entries: "This file has too many parts to be a normal workbook.",
  uncompressed_too_large: `The workbook would unpack to more than ${MAX_IMPORT_UNCOMPRESSED_BYTES / MB} MB.`,
  compression_ratio:
    "The file contains a part that is compressed suspiciously well. It was refused for safety.",
  size_mismatch:
    "The file's contents do not match its own size records. It was refused for safety.",
  overlapping_entries:
    "The file's parts overlap each other. It was refused for safety.",
  inconsistent_entries:
    "The file lists its parts inconsistently. Save it again in Excel and re-upload.",
};

/* Which plan-level fatal code each reason is reported under. */
const CODE_FOR: Record<
  ImportSafetyRejection,
  "not_xlsx" | "too_large" | "zip_unsafe"
> = {
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
};

/** The fatal preview warning for a refusal (whole file, so no sheet). */
export function safetyWarning(reason: ImportSafetyRejection): ImportWarning {
  return importWarning(CODE_FOR[reason], {
    sheet: null,
    detail: IMPORT_SAFETY_MESSAGES[reason],
  });
}

const WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

/**
 * Is this upload safe to hand to exceljs? Checks, in order: size, zip magic,
 * central directory (entry cap before walking it), declared total size,
 * per-entry ratio, encryption/compression method, overlapping data,
 * required parts and content type, macros, then a counting inflate of every
 * entry against its declared size. Returns the entry names on success, so
 * later stages (images) need not re-read the directory.
 */
export async function checkImportFile(
  bytes: Uint8Array,
): Promise<ImportSafetyResult> {
  if (bytes.length === 0) return refuse("empty");
  if (bytes.length > MAX_IMPORT_BYTES) return refuse("too_large");
  if (!hasZipMagic(bytes)) return refuse("not_zip");

  const directory = readCentralDirectory(bytes, {
    maxEntries: MAX_IMPORT_ENTRIES,
    trailer: "none",
  });
  if (!directory.ok) return refuse(directory.reason);
  const entries = directory.entries;

  const structural =
    checkEntryIdentity(bytes, entries) ??
    checkDeclaredSizes(entries) ??
    checkLayout(bytes, entries, directory.directoryOffset);
  if (structural) return refuse(structural);

  const typeProblem = checkWorkbookType(bytes, entries);
  if (typeProblem) return refuse(typeProblem);

  for (const entry of entries) {
    const data = entryData(bytes, entry);
    if (data === "corrupt") return refuse("corrupt");
    const problem = await verifyInflatedSize(data, entry);
    if (problem) return refuse(problem);
  }
  return { ok: true, entryNames: entries.map((e) => e.name) };
}

function refuse(reason: ImportSafetyRejection): ImportSafetyResult {
  return { ok: false, reason };
}

const MAX_32 = 0xffffffff;
const UNICODE_PATH_EXTRA = 0x7075;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/*
 * Each entry must mean the same to us and to JSZip: JSZip takes the name
 * from the LOCAL header (and from a Unicode Path extra field if present),
 * reads 0xFFFFFFFF sizes/offsets from a zip64 extra field, and lets a later
 * entry with the same name replace an earlier one (exceljs also strips a
 * leading "/"). Any of those would let it read parts we never checked.
 */
function checkEntryIdentity(
  bytes: Uint8Array,
  entries: CentralEntry[],
): ImportSafetyRejection | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      entry.compressedSize === MAX_32 ||
      entry.uncompressedSize === MAX_32 ||
      entry.localOffset === MAX_32 ||
      entry.extraFieldIds.includes(UNICODE_PATH_EXTRA)
    ) {
      return "inconsistent_entries";
    }
    try {
      strictUtf8.decode(entry.nameBytes);
    } catch {
      return "inconsistent_entries";
    }
    const at = entry.localOffset;
    if (at + 30 > bytes.length) return "corrupt";
    const localLength = view.getUint16(at + 26, true);
    if (at + 30 + localLength > bytes.length) return "corrupt";
    const localName = bytes.subarray(at + 30, at + 30 + localLength);
    if (!sameBytes(localName, entry.nameBytes)) return "inconsistent_entries";
    const key = entry.name.replace(/^\/+/, "");
    if (seen.has(key)) return "inconsistent_entries";
    seen.add(key);
  }
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* Total declared size and per-entry ratio, from the directory alone. */
function checkDeclaredSizes(
  entries: CentralEntry[],
): ImportSafetyRejection | null {
  let total = 0;
  for (const entry of entries) total += entry.uncompressedSize;
  if (total > MAX_IMPORT_UNCOMPRESSED_BYTES) return "uncompressed_too_large";
  for (const entry of entries) {
    // Folder entries and small parts are skipped: a bomb needs volume.
    if (entry.uncompressedSize <= IMPORT_RATIO_MIN_BYTES) continue;
    const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize);
    if (ratio > MAX_IMPORT_COMPRESSION_RATIO) return "compression_ratio";
  }
  return null;
}

/*
 * Encryption, compression method and data layout. Each entry's data must sit
 * in its own byte range before the central directory: overlapping ranges are
 * how "one kernel, many entries" bombs beat per-entry caps.
 */
function checkLayout(
  bytes: Uint8Array,
  entries: CentralEntry[],
  directoryOffset: number,
): ImportSafetyRejection | null {
  const ranges: [number, number][] = [];
  for (const entry of entries) {
    if ((entry.flags & 1) !== 0) return "unsupported_entry"; // encrypted
    if (entry.method !== 0 && entry.method !== 8) return "unsupported_entry";
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
      return "size_mismatch";
    }
    const data = entryData(bytes, entry);
    if (data === "corrupt") return "corrupt";
    const end = data.byteOffset - bytes.byteOffset + data.length;
    if (end > directoryOffset) return "overlapping_entries";
    ranges.push([entry.localOffset, end]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1] as [number, number];
    const current = ranges[i] as [number, number];
    if (current[0] < previous[1]) return "overlapping_entries";
  }
  return null;
}

/*
 * A real .xlsx: both required parts, the workbook part declared with the
 * plain spreadsheet type (not .xlsm or a template), and no VBA project.
 */
function checkWorkbookType(
  bytes: Uint8Array,
  entries: CentralEntry[],
): ImportSafetyRejection | null {
  const byName = new Map(entries.map((e) => [e.name, e]));
  if (byName.has("xl/vbaProject.bin")) return "macro_enabled";
  const types = byName.get("[Content_Types].xml");
  if (!types || !byName.has("xl/workbook.xml")) return "not_xlsx";

  const text = readZipPart(bytes, types, MAX_XLSX_PART_BYTES);
  if (text === "corrupt") return "corrupt";
  if (text === null) return "not_xlsx";
  // A VBA project is known by its content type, whatever its part name.
  if (/macroEnabled|vnd\.ms-office\.vbaProject/i.test(text)) {
    return "macro_enabled";
  }
  const workbookType = overrideFor(text, "/xl/workbook.xml");
  return workbookType === WORKBOOK_CONTENT_TYPE ? null : "not_xlsx";
}

/* The ContentType of the <Override> for one part name, attribute order free. */
function overrideFor(typesXml: string, partName: string): string | null {
  for (const match of typesXml.matchAll(/<Override\b[^>]*>/g)) {
    const tag = match[0];
    const name = /\bPartName\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (name?.toLowerCase() !== partName) continue;
    return /\bContentType\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? null;
  }
  return null;
}

/*
 * Inflates one entry, counting bytes and discarding them, and stops as soon
 * as the output passes the declared size. Memory stays at one chunk.
 */
function verifyInflatedSize(
  data: Uint8Array,
  entry: CentralEntry,
): Promise<ImportSafetyRejection | null> {
  if (entry.method === 0) return Promise.resolve(null); // stored: sizes equal
  return new Promise((resolve) => {
    const inflater = createInflateRaw();
    let total = 0;
    let settled = false;
    const settle = (result: ImportSafetyRejection | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    inflater.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > entry.uncompressedSize) {
        settle("size_mismatch");
        inflater.destroy();
      }
    });
    inflater.on("end", () =>
      settle(total === entry.uncompressedSize ? null : "size_mismatch"),
    );
    inflater.on("error", () => settle("corrupt"));
    inflater.end(data);
  });
}
