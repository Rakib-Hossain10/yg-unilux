// Writes the checked import file back out as a plain zip, with some parts
// replaced (the sheet guard's output). Used only by safety.ts, after every
// zip check passed, so exceljs and the image reader read exactly the bytes
// that were checked and guarded. Pure: bytes in, bytes out.
//
// Untouched entries keep their compressed data byte for byte (no inflate, no
// recompress); replaced entries are deflated afresh. The output is the
// simplest zip there is: entries in directory order, sizes in the local
// headers (no data descriptors), no extra fields, no comments, no zip64.
// Every entry's name bytes and UTF-8 flag are kept as they were.

import { crc32, deflateRawSync } from "node:zlib";

import { entryData, type CentralEntry } from "@/lib/xlsx-signature";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;
const VERSION = 20; // 2.0: deflate
const UTF8_FLAG = 0x0800;
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;

interface Written {
  entry: CentralEntry;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  offset: number;
}

/**
 * The zip with `replacements` (part name → new uncompressed bytes) applied.
 * "corrupt" if an entry's data cannot be located (safety.ts has already
 * ruled that out; this only keeps the function total).
 */
export function rebuildZip(
  bytes: Uint8Array,
  entries: readonly CentralEntry[],
  replacements: ReadonlyMap<string, Uint8Array>,
): Uint8Array | "corrupt" {
  const chunks: Uint8Array[] = [];
  const written: Written[] = [];
  let offset = 0;

  for (const entry of entries) {
    const replacement = replacements.get(entry.name);
    let data: Uint8Array;
    let method: number;
    let crc: number;
    let uncompressedSize: number;
    if (replacement === undefined) {
      const original = entryData(bytes, entry);
      if (original === "corrupt") return "corrupt";
      data = original;
      method = entry.method;
      crc = entry.crc32;
      uncompressedSize = entry.uncompressedSize;
    } else {
      data = deflateRawSync(replacement);
      method = 8;
      crc = crc32(replacement);
      uncompressedSize = replacement.length;
    }
    const record = {
      entry,
      method,
      crc,
      compressedSize: data.length,
      uncompressedSize,
      offset,
    };
    const header = localHeader(record);
    chunks.push(header, data);
    written.push(record);
    offset += header.length + data.length;
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const record of written) {
    const header = centralHeader(record);
    chunks.push(header);
    directorySize += header.length;
  }
  chunks.push(endRecord(written.length, directorySize, directoryOffset));
  return concat(chunks);
}

function localHeader(record: Written): Uint8Array {
  const name = record.entry.nameBytes;
  const out = new Uint8Array(30 + name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, LOCAL_HEADER, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, record.entry.flags & UTF8_FLAG, true);
  view.setUint16(8, record.method, true);
  view.setUint16(10, 0, true); // time 00:00
  view.setUint16(12, DOS_DATE_1980_01_01, true);
  view.setUint32(14, record.crc, true);
  view.setUint32(18, record.compressedSize, true);
  view.setUint32(22, record.uncompressedSize, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true); // no extra field
  out.set(name, 30);
  return out;
}

function centralHeader(record: Written): Uint8Array {
  const name = record.entry.nameBytes;
  const out = new Uint8Array(46 + name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, CENTRAL_HEADER, true);
  view.setUint16(4, VERSION, true); // made by: MS-DOS, 2.0
  view.setUint16(6, VERSION, true);
  view.setUint16(8, record.entry.flags & UTF8_FLAG, true);
  view.setUint16(10, record.method, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, DOS_DATE_1980_01_01, true);
  view.setUint32(16, record.crc, true);
  view.setUint32(20, record.compressedSize, true);
  view.setUint32(24, record.uncompressedSize, true);
  view.setUint16(28, name.length, true);
  // extra, comment, disk, internal and external attributes: all zero
  view.setUint32(42, record.offset, true);
  out.set(name, 46);
  return out;
}

function endRecord(count: number, size: number, offset: number): Uint8Array {
  const out = new Uint8Array(22);
  const view = new DataView(out.buffer);
  view.setUint32(0, EOCD, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
