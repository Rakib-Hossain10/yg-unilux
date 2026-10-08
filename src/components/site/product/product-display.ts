// Pure helpers that turn a PublicProductView (public values only, ADR 0063)
// into what the product page shows: the variant on display, quick-spec rows,
// grouped table rows, the Models comparison, title and meta description.

import type { PublicProductView, PublicVariantView } from "@/lib/catalog/view";
import {
  SPEC_COLUMNS,
  specColumnsFor,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

/** One shown spec: its label and its value(s). Several values = options. */
export interface SpecRow {
  key: SpecKey;
  label: string;
  values: string[];
}

/** One titled group of the full spec table. */
export interface SpecGroup {
  title: string;
  rows: SpecRow[];
}

/* Upper-case words (CCT, CRI, IP, SDCM) stay as they are. */
const isAcronym = (word: string): boolean =>
  /[A-Z]/.test(word) && word === word.toUpperCase();

/**
 * A sheet header in sentence case for the page ("Housing Color/Finish" →
 * "Housing color/finish", "IP Rating" → "IP rating", "CCT" stays).
 */
export function sentenceCase(header: string): string {
  return header
    .split(" ")
    .map((word, index) =>
      index === 0 || isAcronym(word) ? word : word.toLowerCase(),
    )
    .join(" ");
}

const LABEL_BY_KEY = new Map<SpecKey, string>(
  SPEC_COLUMNS.map((column) => [column.key, sentenceCase(column.header)]),
);

/** The page label of a spec column. */
export function specLabel(key: SpecKey): string {
  return LABEL_BY_KEY.get(key) ?? key;
}

/** The variant the static page shows: the first one, or null when none. */
export function displayVariant(
  product: Pick<PublicProductView, "variants">,
): PublicVariantView | null {
  return product.variants[0] ?? null;
}

/**
 * The values on display: the first variant's merged values, else the
 * product's own. Both hold public keys only (the view never has others).
 */
export function displaySpecs(
  product: Pick<PublicProductView, "variants" | "specs">,
): SpecValues {
  return displayVariant(product)?.specs ?? product.specs;
}

function rowsFor(
  columns: readonly { key: SpecKey }[],
  specs: SpecValues,
): SpecRow[] {
  return columns.flatMap((column) => {
    const values = specs[column.key];
    return values && values.length > 0
      ? [{ key: column.key, label: specLabel(column.key), values }]
      : [];
  });
}

/** The quick-spec panel rows (placement "quick", ADR 0054), empty hidden. */
export function quickSpecRows(specs: SpecValues): SpecRow[] {
  return rowsFor(specColumnsFor("quick"), specs);
}

/**
 * The full spec table (placement "table"), grouped by SPEC_COLUMNS `group`
 * in sheet order. Empty values and empty groups are hidden.
 */
export function specTableGroups(specs: SpecValues): SpecGroup[] {
  const groups: SpecGroup[] = [];
  for (const column of specColumnsFor("table")) {
    const values = specs[column.key];
    if (!values || values.length === 0) continue;
    const row = { key: column.key, label: specLabel(column.key), values };
    const last = groups.at(-1);
    if (last && last.title === column.group) last.rows.push(row);
    else groups.push({ title: column.group, rows: [row] });
  }
  return groups;
}

/** The admin's extra specs, grouped in stored order; no group = "Additional information". */
export function extraSpecGroups(
  extras: PublicProductView["extraSpecs"],
): { title: string; rows: { label: string; value: string }[] }[] {
  const byTitle = new Map<string, { label: string; value: string }[]>();
  for (const extra of extras) {
    if (extra.label.trim() === "" || extra.value.trim() === "") continue;
    const title = extra.group?.trim() || "Additional information";
    const rows = byTitle.get(title) ?? [];
    rows.push({ label: extra.label, value: extra.value });
    byTitle.set(title, rows);
  }
  return [...byTitle].map(([title, rows]) => ({ title, rows }));
}

/** The output readout next to the optic switch (CLAUDE.md, plan Q4). */
export const READOUT_KEYS = ["lumenOutput", "lumenEfficiency"] as const;

const sameValues = (a?: string[], b?: string[]): boolean =>
  (a ?? []).join("\u0000") === (b ?? []).join("\u0000");

/**
 * The Models table: the columns worth comparing (lumen output and efficiency
 * when any variant has them, plus every other public column whose value
 * differs between variants), in sheet order. Only for 2+ variants.
 */
export function modelsTableColumns(
  variants: readonly PublicVariantView[],
): SpecKey[] {
  if (variants.length < 2) return [];
  const first = variants[0]!;
  return SPEC_COLUMNS.map((column) => column.key).filter((key) => {
    const anyValue = variants.some((v) => (v.specs[key]?.length ?? 0) > 0);
    if (!anyValue) return false;
    if ((READOUT_KEYS as readonly SpecKey[]).includes(key)) return true;
    return variants.some((v) => !sameValues(v.specs[key], first.specs[key]));
  });
}

/** The option name of a variant: its label, else its model no. */
export function variantName(variant: PublicVariantView): string {
  return variant.label?.trim() || variant.modelNo;
}

/** "Arc AR-013A": name plus base model code, unless the name already holds it. */
export function productTitle(
  product: Pick<PublicProductView, "name" | "modelCode">,
): string {
  const code = product.modelCode?.trim();
  if (!code || product.name.toLowerCase().includes(code.toLowerCase())) {
    return product.name;
  }
  return `${product.name} ${code}`;
}

/* The public columns a meta description mentions, in this order. */
const DESCRIPTION_KEYS: readonly SpecKey[] = [
  "wattage",
  "cct",
  "cri",
  "beamAngle",
  "ipRating",
];

/**
 * The meta description: the product's own description, else one templated
 * sentence of public values. Built from the public view only, so it can
 * never hold a restricted value (rule 9).
 */
export function metaDescription(product: PublicProductView): string {
  const own = product.description?.trim();
  if (own) return own.length > 300 ? `${own.slice(0, 297)}...` : own;
  const specs = displaySpecs(product);
  const facts = DESCRIPTION_KEYS.flatMap((key) => {
    const values = specs[key];
    return values && values.length > 0
      ? [`${specLabel(key)} ${values.join(", ")}`]
      : [];
  });
  const kind = product.type?.trim();
  const lead = kind
    ? `${productTitle(product)}: ${kind} by YG UniLUX.`
    : `${productTitle(product)} by YG UniLUX.`;
  return facts.length > 0 ? `${lead} ${facts.join("; ")}.` : lead;
}
