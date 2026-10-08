// A tiny raw zip writer for crafting malformed archives in tests (stored
// entries only). Every field JSZip reads can be set by hand, so a test can
// build exactly the parser differential it wants to prove we refuse.

export interface RawEntry {
  name: string;
  data?: Uint8Array;
  /** Name in the local header, when it should differ from the central one. */
  localName?: string;
  /** Central-directory extra field bytes (id + size + data, already encoded). */
  extra?: Uint8Array;
  /** Override the declared sizes / offset in the central directory. */
  compressedSize?: number;
  uncompressedSize?: number;
  /*
   * Central-directory-only entry whose local header lies INSIDE another
   * entry's data: `at` bytes into the data of entry number `entry`.
   */
  pointInto?: { entry: number; at: number };
}

export interface RawZipOptions {
  /** Entry count written in the end record (default: the real count). */
  count?: number;
  /** "Number of this disk" in the end record (default 0). */
  diskNumber?: number;
  /** Bytes appended after the end record (outside its comment). */
  trailing?: Uint8Array;
}

const encoder = new TextEncoder();

/** An extra field: 2-byte id, 2-byte length, data. */
export function extraField(id: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, id, true);
  view.setUint16(2, data.length, true);
  out.set(data, 4);
  return out;
}

/** A bare local header + data, to hide inside another entry's data. */
export function localRecord(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = encoder.encode(name);
  const out = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, data.length, true);
  view.setUint32(22, data.length, true);
  view.setUint16(26, nameBytes.length, true);
  out.set(nameBytes, 30);
  out.set(data, 30 + nameBytes.length);
  return out;
}

export function rawZip(
  entries: RawEntry[],
  options: RawZipOptions = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const dataStarts: number[] = [];
  for (const entry of entries) {
    const data = entry.data ?? new Uint8Array(0);
    if (entry.pointInto) {
      const name = encoder.encode(entry.name);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      const start = dataStarts[entry.pointInto.entry] ?? 0;
      cv.setUint32(42, start + entry.pointInto.at, true);
      central.set(name, 46);
      centrals.push(central);
      dataStarts.push(-1);
      continue;
    }
    const localName = encoder.encode(entry.localName ?? entry.name);
    const local = new Uint8Array(30 + localName.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, localName.length, true);
    local.set(localName, 30);
    chunks.push(local, data);
    dataStarts.push(offset + local.length);

    const name = encoder.encode(entry.name);
    const extra = entry.extra ?? new Uint8Array(0);
    const central = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(20, entry.compressedSize ?? data.length, true);
    cv.setUint32(24, entry.uncompressedSize ?? data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    central.set(extra, 46 + name.length);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const directorySize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, options.diskNumber ?? 0, true);
  ev.setUint16(8, options.count ?? entries.length, true);
  ev.setUint16(10, options.count ?? entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const parts = [
    ...chunks,
    ...centrals,
    end,
    options.trailing ?? new Uint8Array(0),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
