// Rewrites parts of a built fixture (.xlsx bytes) for tests that need what
// exceljs cannot write: other image stores (WPS cellimages, Excel richData),
// EMF pictures, absolute anchors, linked pictures. Test-only: production
// code never imports JSZip itself (exceljs does, after safety.ts); our own
// zip reading goes through src/lib/xlsx-signature.ts.

import JSZip from "jszip";

/** A part's new content, a function of its old text, or null to delete it. */
export type PartEdit = string | Uint8Array | ((old: string) => string) | null;

/** Applies the edits (by part name) and returns new deflated .xlsx bytes. */
export async function patchZip(
  bytes: Uint8Array,
  edits: Record<string, PartEdit>,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  for (const [name, edit] of Object.entries(edits)) {
    if (edit === null) {
      if (zip.file(name) === null) {
        throw new Error(`patchZip: no part ${name} to delete`);
      }
      zip.remove(name);
    } else if (typeof edit === "function") {
      const old = await zip.file(name)?.async("string");
      if (old === undefined) throw new Error(`patchZip: no part ${name}`);
      zip.file(name, edit(old));
    } else {
      zip.file(name, edit);
    }
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** The bytes of one part, for assertions. */
export async function readPart(
  bytes: Uint8Array,
  name: string,
): Promise<Uint8Array | undefined> {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(name)?.async("uint8array");
}

/** The first EMF bytes: an EMR_HEADER record with the " EMF" signature. */
export function emfBytes(): Uint8Array {
  const out = new Uint8Array(108);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, true); // EMR_HEADER
  view.setUint32(4, 108, true); // record size
  view.setUint32(40, 0x464d4520, true); // " EMF"
  return out;
}
