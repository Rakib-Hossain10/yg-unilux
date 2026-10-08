// Pure rules of the product page's restricted block (plan P7, ADR 0064):
// reading the answer of GET /api/catalog/restricted/[productId] defensively,
// and choosing the restricted rows for the selected variant. No React, no DOM.

/*
 * The answer is only ever held in client memory after hydration; nothing here
 * runs on the server render, so no restricted value reaches static HTML.
 */

import { modelNoKey } from "@/models/product-constants";
import {
  SPEC_KEYS,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import { specLabel } from "./product-display";

/** The route that answers per viewer (`private, no-store`). */
export const restrictedUrl = (productId: string): string =>
  `/api/catalog/restricted/${encodeURIComponent(productId)}`;

/** The datasheet download route (Phase 5 builds it; ADR 0002 rule 2). */
export const datasheetUrl = (productId: string): string =>
  `/api/datasheet/${encodeURIComponent(productId)}`;

/**
 * The datasheet button state the route sends (`@/lib/datasheet-state`). Kept
 * here so page modules never import that file: it reaches permissions/auth
 * (the page's static guard); the unit test checks the two stay equal.
 */
export type DatasheetButtonState =
  "download" | "expired" | "signin" | "coming-soon";

export interface RestrictedVariant {
  modelNo: string;
  specs: SpecValues;
}

export type RestrictedAnswer =
  | { allowed: false; state: DatasheetButtonState }
  | {
      allowed: true;
      state: DatasheetButtonState;
      keys: SpecKey[];
      specs: SpecValues;
      variants: RestrictedVariant[];
    };

const STATES: ReadonlySet<string> = new Set<DatasheetButtonState>([
  "download",
  "expired",
  "signin",
  "coming-soon",
]);
const KNOWN_KEYS: ReadonlySet<string> = new Set(SPEC_KEYS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/* Only known keys with string values survive; anything else is dropped. */
function readSpecs(value: unknown): SpecValues {
  if (!isRecord(value)) return {};
  const out: SpecValues = {};
  for (const [key, values] of Object.entries(value)) {
    if (!KNOWN_KEYS.has(key) || !Array.isArray(values)) continue;
    const strings = values.filter(
      (item): item is string => typeof item === "string" && item !== "",
    );
    if (strings.length > 0) out[key as SpecKey] = strings;
  }
  return out;
}

/**
 * The route's JSON as a typed answer, or null when it is not a shape we
 * know (the block then keeps its server-rendered fallback).
 */
export function parseRestrictedAnswer(body: unknown): RestrictedAnswer | null {
  if (!isRecord(body) || typeof body.state !== "string") return null;
  if (!STATES.has(body.state)) return null;
  const state = body.state as DatasheetButtonState;
  if (body.allowed === false) return { allowed: false, state };
  if (body.allowed !== true) return null;
  if (!Array.isArray(body.keys) || !Array.isArray(body.variants)) return null;
  const keys = body.keys.filter(
    (key): key is SpecKey => typeof key === "string" && KNOWN_KEYS.has(key),
  );
  const variants = body.variants.flatMap((variant): RestrictedVariant[] =>
    isRecord(variant) && typeof variant.modelNo === "string"
      ? [{ modelNo: variant.modelNo, specs: readSpecs(variant.specs) }]
      : [],
  );
  return {
    allowed: true,
    state,
    keys: [...new Set(keys)],
    specs: readSpecs(body.specs),
    variants,
  };
}

/**
 * Asks the route for this viewer's answer: never cached (`no-store`), the
 * session cookie only (same origin), abortable. Resolves null on any failure
 * (offline, aborted, non-200, unknown shape) so the caller keeps its fallback.
 */
export async function loadRestrictedAnswer(
  productId: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<RestrictedAnswer | null> {
  try {
    const response = await fetchImpl(restrictedUrl(productId), {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) return null;
    const answer = parseRestrictedAnswer(await response.json());
    return signal.aborted ? null : answer;
  } catch {
    return null;
  }
}

/**
 * The restricted values of the selected variant: the variant at `index` when
 * its model no. matches, else the one with that model no., else the
 * product-level values (a product saved without variants). The route merges
 * product values into each variant already.
 */
export function restrictedSpecsFor(
  answer: Extract<RestrictedAnswer, { allowed: true }>,
  index: number,
  modelNo: string | undefined,
): SpecValues {
  const key = modelNo ? modelNoKey(modelNo) : "";
  const atIndex = answer.variants[index];
  if (atIndex && (key === "" || modelNoKey(atIndex.modelNo) === key)) {
    return atIndex.specs;
  }
  const byModel =
    key === ""
      ? undefined
      : answer.variants.find((variant) => modelNoKey(variant.modelNo) === key);
  return byModel?.specs ?? answer.specs;
}

export interface RestrictedRow {
  key: SpecKey;
  label: string;
}

/**
 * The restricted rows to show: every restricted column the product or any
 * variant fills, in sheet order (the route's key order), so a variant switch
 * never adds or removes a row (same rule as the public table, P5).
 */
export function restrictedRows(
  answer: Extract<RestrictedAnswer, { allowed: true }>,
): RestrictedRow[] {
  const filled = (specs: SpecValues, key: SpecKey) =>
    (specs[key]?.length ?? 0) > 0;
  return answer.keys
    .filter(
      (key) =>
        filled(answer.specs, key) ||
        answer.variants.some((variant) => filled(variant.specs, key)),
    )
    .map((key) => ({ key, label: specLabel(key) }));
}
