// The import's column map: which sheet header means which column key. Pure.
// T2 holds the header part; T3 adds each column's split policy here.
//
// Headers are "English\nChinese" (CLAUDE.md). We match on the English first
// line only, case-insensitively, with spaces collapsed and a trailing "."
// optional, because the client's sheet spells them loosely ("HOLDER",
// "Voltage INPUT", "Batch No.\n批号 ").

import { SPEC_COLUMNS } from "@/models/spec-columns";

import type { ColumnKey, IdentityKey, TemplateKey } from "./types";

/** The five non-spec sheet columns, by their English header. */
export const IDENTITY_COLUMNS: readonly {
  key: IdentityKey;
  header: string;
}[] = [
  { key: "productNo", header: "NO." },
  { key: "family", header: "Model Name" },
  { key: "type", header: "Model Type" },
  { key: "modelNo", header: "Model No." },
  { key: "image", header: "Image" },
];

/** Optional columns the admin may add to assign categories and areas. */
export const TEMPLATE_COLUMNS: readonly {
  key: TemplateKey;
  header: string;
}[] = [
  { key: "category", header: "Category" },
  { key: "extraCategories", header: "Extra Categories" },
  { key: "areas", header: "Areas" },
];

/** Without these two the sheet cannot be grouped: the file is refused. */
export const REQUIRED_COLUMNS: readonly ColumnKey[] = ["productNo", "modelNo"];

/* CJK characters, so "Lens 透镜" on one line still matches "Lens". */
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/gu;

/**
 * The comparable form of a header cell: NFKC (full-width letters to ASCII),
 * first line only, CJK removed, lowercase, spaces collapsed, trimmed, one
 * trailing "." dropped. "Voltage INPUT\n输入电压 " → "voltage input".
 */
export function normalizeHeader(raw: string): string {
  const firstLine = raw.normalize("NFKC").split(/\r?\n/, 1)[0] ?? "";
  return firstLine
    .replace(CJK, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "")
    .trim();
}

const BY_HEADER: ReadonlyMap<string, ColumnKey> = new Map<string, ColumnKey>(
  [...IDENTITY_COLUMNS, ...SPEC_COLUMNS, ...TEMPLATE_COLUMNS].map((column) => [
    normalizeHeader(column.header),
    column.key,
  ]),
);

/** The column key for a header cell's text, or null when it is unknown. */
export function columnForHeader(raw: string): ColumnKey | null {
  const normalized = normalizeHeader(raw);
  if (normalized === "") return null;
  return BY_HEADER.get(normalized) ?? null;
}
