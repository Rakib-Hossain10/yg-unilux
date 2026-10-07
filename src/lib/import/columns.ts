// The import's column map: which sheet header means which column key, and how
// each column's multi-line cells are split (the split policy). Pure.
//
// Headers are "English\nChinese" (CLAUDE.md). We match on the English first
// line only, case-insensitively, with spaces collapsed and a trailing "."
// optional, because the client's sheet spells them loosely ("HOLDER",
// "Voltage INPUT", "Batch No.\n批号 ").

import { SPEC_COLUMNS, type SpecKey } from "@/models/spec-columns";

import type { ColumnKey, IdentityKey, TemplateKey } from "./types";

/**
 * How a multi-line cell becomes values (plan cleaning rule 7):
 * - `options`: each line is one option ("3000K\n4000K" → two chips);
 * - `options+slash`: lines and "/" both separate options ("White/Black");
 * - `join`: the lines are one value spread over several lines, joined with a
 *   space ("Die Casting\nAluminium + PC" → "Die Casting Aluminium + PC").
 * Only `options+slash` splits on "/", so "AC100-240V/50-60Hz" stays one value.
 */
export type SplitPolicy = "options" | "options+slash" | "join";

/**
 * The split policy of every spec key plus the two text identity columns.
 * `satisfies` makes a new spec key fail to compile until it has a policy,
 * and columns.test.ts pins every entry. Decided from the client's sheet.
 */
export const SPLIT_POLICY = {
  // Lists of choices: CCTs, beam angles, wattages, ...
  cct: "options",
  beamAngle: "options",
  wattage: "options",
  lumenOutput: "options",
  lumenEfficiency: "options",
  cri: "options",
  ugr: "options",
  ipRating: "options",
  voltageInput: "options",
  chipType: "options",
  driver: "options",
  dimmable: "options",
  // Colours written "White/Black".
  housingFinish: "options+slash",
  reflectorColor: "options+slash",
  // One description wrapped over lines.
  housingMaterial: "join",
  lens: "join",
  reflector: "join",
  diffuser: "join",
  dimensions: "join",
  cutOutSize: "join",
  rotatingAngle: "join",
  holder: "join",
  chipEfficiency: "join",
  powerFactor: "join",
  sdcm: "join",
  lifespan: "join",
  warrantyPeriod: "join",
  batchNo: "join",
  // Identity text: "Pull-Down Spot Light\nTrim Round 1 Head" is one type.
  family: "join",
  type: "join",
} as const satisfies Record<SpecKey | "family" | "type", SplitPolicy>;

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

/**
 * The CJK characters the import removes (English only, plan decision 7), as
 * a regex character-class body: Han, Hiragana, Katakana, Hangul, Bopomofo,
 * CJK symbols and punctuation (U+3000–303F), CJK compatibility forms
 * (U+FE30–FE4F) and the full-width forms NFKC leaves (U+FF00–FFEF).
 * Shared by header matching and the cell cleaner (clean.ts).
 */
export const CJK_CLASS =
  "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\p{Script=Bopomofo}\\u3000-\\u303F\\uFE30-\\uFE4F\\uFF00-\\uFFEF";

/* CJK characters, so "Lens 透镜" on one line still matches "Lens". */
const CJK = new RegExp(`[${CJK_CLASS}]`, "gu");

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
