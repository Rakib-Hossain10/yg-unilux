// Test helper: runs the import safety check and returns the CheckedImportFile
// that readWorkbook and readEmbeddedImages require, or throws with the reason.
// The same path production uses (check → read), so tests never feed the
// parsers bytes the check did not see.

import { createHash } from "node:crypto";

import { checkImportFile, type CheckedImportFile } from "@/lib/import/safety";
import { readCentralDirectory, readZipBytes } from "@/lib/xlsx-signature";

export async function checked(bytes: Uint8Array): Promise<CheckedImportFile> {
  const result = await checkImportFile(bytes);
  if (!result.ok) {
    throw new Error(`checkImportFile refused the bytes: ${result.reason}`);
  }
  return result.file;
}

/**
 * Every part of a zip, uncompressed, by name (through the production zip
 * reader). For "the checked file holds the same parts" assertions.
 */
export function partsOf(bytes: Uint8Array): Map<string, Uint8Array> {
  const directory = readCentralDirectory(bytes, {
    maxEntries: 10_000,
    trailer: "none",
  });
  if (!directory.ok) throw new Error(`not a zip: ${directory.reason}`);
  const parts = new Map<string, Uint8Array>();
  for (const entry of directory.entries) {
    const data = readZipBytes(bytes, entry, 400 * 1024 * 1024);
    if (data === null || data === "corrupt") {
      throw new Error(`unreadable part ${entry.name}`);
    }
    parts.set(entry.name, new Uint8Array(data));
  }
  return parts;
}

/** sha256 of every part, by name: fast equality for large parts (pictures). */
export function digestsOf(bytes: Uint8Array): Map<string, string> {
  const digests = new Map<string, string>();
  for (const [name, data] of partsOf(bytes)) {
    digests.set(name, createHash("sha256").update(data).digest("hex"));
  }
  return digests;
}
