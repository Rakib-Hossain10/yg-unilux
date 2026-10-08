// Pure rules of the optic (variant) switcher, shared by the server panel and
// the client switcher: deep-link parsing (?model=), URL building, the legend,
// the spoken announcement and "did this value change". No React, no DOM.

import {
  type PublicVariantView,
  VARIANT_LABEL_SOURCE_KEYS,
} from "@/lib/catalog/view";
import { modelNoKey } from "@/models/product-constants";
import type { SpecKey, SpecValues } from "@/models/spec-columns";

import { READOUT_KEYS, specLabel } from "./product-display";

/** The search parameter that names the selected model (plan Q3). */
export const MODEL_PARAM = "model";

/* Model nos. are at most 64 characters (schema); anything longer is noise. */
const MAX_MODEL_PARAM_LENGTH = 64;

/** What the switcher needs of a variant: public values only (rule 9). */
export type SwitchVariant = Pick<
  PublicVariantView,
  "modelNo" | "label" | "imagePublicId" | "specs"
>;

/** The `?model=` value of a query string ("?a=1&model=X"), or null. */
export function modelFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(MODEL_PARAM)?.trim() ?? "";
  if (value === "" || value.length > MAX_MODEL_PARAM_LENGTH) return null;
  return value;
}

/**
 * The index of the variant whose model no. is `model` (case-insensitive, the
 * same rule as the unique index, ADR 0055), or null when none matches.
 */
export function variantIndexForModel(
  variants: readonly Pick<SwitchVariant, "modelNo">[],
  model: string | null | undefined,
): number | null {
  if (!model) return null;
  const key = modelNoKey(model);
  if (key === "") return null;
  const index = variants.findIndex(
    (variant) => modelNoKey(variant.modelNo) === key,
  );
  return index === -1 ? null : index;
}

/**
 * The same URL with `?model=` set to `modelNo` (or removed for null), every
 * other parameter and the hash kept. Returns a path, never an origin, so it
 * is safe for history.replaceState.
 */
export function urlWithModel(href: string, modelNo: string | null): string {
  const url = new URL(href, "http://localhost");
  if (modelNo === null) url.searchParams.delete(MODEL_PARAM);
  else url.searchParams.set(MODEL_PARAM, modelNo);
  return `${url.pathname}${url.search}${url.hash}`;
}

const sameValues = (a?: readonly string[], b?: readonly string[]): boolean =>
  (a ?? []).join("\u0000") === (b ?? []).join("\u0000");

/** True when a field shows something different for the two variants. */
export function valueChanged(
  field: "model-no" | SpecKey,
  from: SwitchVariant | undefined,
  to: SwitchVariant | undefined,
): boolean {
  if (!from || !to) return false;
  if (field === "model-no") return from.modelNo !== to.modelNo;
  return !sameValues(from.specs[field], to.specs[field]);
}

/**
 * The public columns whose value is not the same for every variant, in sheet
 * order, without the output readout (lumen differs as a consequence).
 */
export function differingKeys(variants: readonly SwitchVariant[]): SpecKey[] {
  const first = variants[0];
  if (!first || variants.length < 2) return [];
  const keys = new Set<SpecKey>();
  for (const variant of variants) {
    for (const key of Object.keys({
      ...first.specs,
      ...variant.specs,
    }) as SpecKey[]) {
      if (!sameValues(first.specs[key], variant.specs[key])) keys.add(key);
    }
  }
  const readout = new Set<SpecKey>(READOUT_KEYS);
  return [...keys].filter((key) => !readout.has(key));
}

/**
 * The switcher's legend: the differing column when exactly one differs
 * ("Lens"), the optic columns joined when only those differ ("Lens /
 * Reflector"), otherwise "Option". Column names only, never values.
 */
export function switcherLegend(variants: readonly SwitchVariant[]): string {
  const keys = differingKeys(variants);
  if (keys.length === 0) return "Option";
  if (keys.length === 1) return specLabel(keys[0]!);
  const optic = new Set(VARIANT_LABEL_SOURCE_KEYS);
  return keys.every((key) => optic.has(key))
    ? keys.map(specLabel).join(" / ")
    : "Option";
}

/* "1200", "1200lm", "1,200 lm" -> "1200"; null when it is not one number. */
function numberWithUnit(value: string, unit: RegExp): string | null {
  const match = new RegExp(
    String.raw`^\s*(\d[\d,]*(?:\.\d+)?)\s*(?:${unit.source})?\s*$`,
    "i",
  ).exec(value);
  return match ? match[1]!.replace(/,/g, "") : null;
}

function spokenValue(key: SpecKey, values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const unit = key === "lumenOutput" ? /lm|lumens?/ : /lm\s*\/\s*w/;
  const word = key === "lumenOutput" ? "lumens" : "lm/W";
  const numbers = values.map((value) => numberWithUnit(value, unit));
  if (numbers.every((n): n is string => n !== null)) {
    return `${numbers.join(" or ")} ${word}`;
  }
  return `${specLabel(key).toLowerCase()} ${values.join(" or ")}`;
}

/**
 * The polite live-region text after a switch, e.g. "AR-013A2 selected, 1200
 * lumens, 100 lm/W". Values the variant does not have are left out.
 */
export function variantAnnouncement(variant: SwitchVariant): string {
  const parts = READOUT_KEYS.flatMap((key) => {
    const spoken = spokenValue(key, variant.specs[key] ?? []);
    return spoken ? [spoken] : [];
  });
  return [`${variant.modelNo} selected`, ...parts].join(", ");
}

/** Spec values present for a key in any variant: rows that may be shown. */
export function unionVariantSpecs(
  variants: readonly SwitchVariant[],
  fallback: SpecValues,
): SpecValues {
  if (variants.length === 0) return fallback;
  const out: SpecValues = {};
  for (const variant of variants) {
    for (const [key, values] of Object.entries(variant.specs) as [
      SpecKey,
      string[] | undefined,
    ][]) {
      if (!out[key] && values && values.length > 0) out[key] = values;
    }
  }
  return out;
}
