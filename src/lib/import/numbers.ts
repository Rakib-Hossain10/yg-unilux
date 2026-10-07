// The import's filter parsers: read the numbers listings filter on (CCT, CRI,
// beam angle, UGR, wattage, IP) out of cleaned display strings (plan
// "Numeric filter parsers", ADR 0056). Pure: no I/O, no server-only.
//
// The display string is always kept as typed; a value that yields no number
// is flagged (`unparsed_filter_value`), never guessed.

import { MAX_FILTER_NUMBER, MAX_FILTER_VALUES } from "@/lib/constants";
import type { ProductFilters } from "@/models/product";
import {
  FILTER_KEY_BY_SPEC,
  SPEC_KEYS,
  type FilterKey,
  type SpecKey,
  type SpecValues,
} from "@/models/spec-columns";

import type { CellAt } from "./clean";
import { importWarning, type ImportWarning } from "./types";

/* ---------------------------------------------------------------------------
 * Tokens: each number in a value with the unit written right after it.
 * ------------------------------------------------------------------------- */

interface NumberToken {
  value: number;
  /** Lowercased unit after the number ("k", "w", "°", "deg"), or "". */
  unit: string;
}

/*
 * A number and the unit right after it: "°" alone, a count marker "×" / "*",
 * or a run of letters ("3000K", "24 deg", "1140 LM"). "°" is matched alone so
 * "15°x45°" reads as 15° and 45°, not a unit "°x".
 */
const NUMBER_WITH_UNIT = /(\d+(?:\.\d+)?)[^\S\n]*(°|[×*]|[a-zµ]+)?/gi;

/*
 * A count marker right before a number: "×2", "* 2", "x2" (an "x" that does
 * not end a word). Such a number is a count ("10W*2"), not a value.
 *
 * Read backwards from the number over the gap since the previous token only
 * (never a regex over the whole prefix), so a value with many numbers stays
 * linear: each character is looked at a bounded number of times.
 */
function countBefore(source: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && isGapSpace(source[i] as string)) i--;
  const marker = source[i];
  if (marker === "×" || marker === "*") return true;
  if (marker !== "x" && marker !== "X") return false;
  return i === 0 || !isAsciiLetter(source[i - 1] as string);
}

/* Whitespace other than a line break (a regex's [^\S\n]). */
function isGapSpace(ch: string): boolean {
  return ch !== "\n" && /\s/.test(ch);
}

function isAsciiLetter(ch: string): boolean {
  return /[a-z]/i.test(ch);
}

/* An "x" / "×" / "*" between a number (with or without its unit) and the
 * next number: "2x10W", "18Wx2", "15x45°". Normalised to "×" so the letter x
 * never becomes part of a unit ("wx"). */
const TIMES_BETWEEN = /(?<=\d(?:°|[a-zµ]*))[^\S\n]*[x×*][^\S\n]*(?=\d)/gi;

/* The unit given to counts and codes; no parser accepts it. */
const COUNT = "×";

/* Letters glued to the front of a number make it a code, not a value
 * ("GU10", "MR16", "PAR30"), except these labels ("Ra90", "CRI90", "UGR19",
 * "CCT3000K"). "x" is left to countBefore. */
const VALUE_LABELS = new Set(["ra", "cri", "ugr", "cct", "x"]);

/* The run of ASCII letters glued to the front of the number at `start`,
 * lowercased, or undefined. A backward scan bounded by that run. */
function gluedPrefix(source: string, start: number): string | undefined {
  let i = start;
  while (i > 0 && isAsciiLetter(source[i - 1] as string)) i--;
  return i < start ? source.slice(i, start).toLowerCase() : undefined;
}

/* Text between two numbers that makes them a range or a list sharing the
 * second one's unit: "2700-6500K", "1800~3000K", "3000/4000K", "7 to 10W". */
const RANGE_GAP = /^\s*(?:-|~|–|—|\/|to)\s*$/i;

/*
 * The parts of a value that are not the value itself:
 * - a tolerance after "±" or "+/-" with its unit ("10±1W" → "10");
 * - thousands separators: a run like "3,000" or "50,000" (one comma) or
 *   "1,200,000" (first group of 1-2 digits) is one number. A run of 3-digit
 *   groups with several commas ("100,150,200W") is a list and stays as is.
 */
function normalise(text: string): string {
  return text
    .replace(TIMES_BETWEEN, "×")
    .replace(/(?:±|\+\/-)\s*\d+(?:\.\d+)?\s*(?:%|°|[a-z]+)?/gi, "")
    .replace(/(?<![\d,])\d{1,3}(?:,\d{3})+(?![\d,])/g, (run) => {
      const groups = run.split(",");
      const oneNumber = groups.length === 2 || (groups[0]?.length ?? 0) < 3;
      return oneNumber ? groups.join("") : run;
    });
}

function tokens(text: string): NumberToken[] {
  const source = normalise(text);
  const found: { value: number; unit: string; start: number; end: number }[] =
    [];
  for (const match of source.matchAll(NUMBER_WITH_UNIT)) {
    const start = match.index;
    let unit = (match[2] ?? "").toLowerCase();
    if (unit === "*") unit = COUNT;
    // "to" is a range word ("7 to 10W"), not the unit of the 7.
    if (unit === "to") unit = "";
    if (unit === "" && countBefore(source, start)) unit = COUNT;
    const prefix = gluedPrefix(source, start);
    if (unit === "" && prefix !== undefined && !VALUE_LABELS.has(prefix)) {
      unit = COUNT;
    }
    found.push({
      value: Number(match[1]),
      unit,
      start,
      end: start + (match[1]?.length ?? 0),
    });
  }
  // A unitless number before a range gap takes the next number's unit.
  for (let i = found.length - 2; i >= 0; i--) {
    const here = found[i];
    const next = found[i + 1];
    if (!here || !next || here.unit !== "" || next.unit === "") continue;
    if (RANGE_GAP.test(source.slice(here.end, next.start))) {
      here.unit = next.unit;
    }
  }
  return found.map(({ value, unit }) => ({ value, unit }));
}

/*
 * The numbers of `text` whose unit is one of `units` (or none) and that lie
 * within [min, max]. A number with any other unit is not ours: the 220 in
 * "AC220V 12W" is volts, the 2 in "2x10W" is a count.
 */
function numbersWithUnit(
  text: string,
  units: readonly string[],
  min: number,
  max: number,
): number[] {
  const values = tokens(text)
    .filter((t) => t.unit === "" || units.includes(t.unit))
    .map((t) => t.value)
    .filter((n) => Number.isFinite(n) && n >= min && n <= max);
  return [...new Set(values)];
}

/* ---------------------------------------------------------------------------
 * One parser per filter. Each takes one display string (one option).
 * ------------------------------------------------------------------------- */

/** CCT in kelvin, 1000–10000: "3000K", "2700K-6500K" (both ends), "CCT 3000K". */
export function parseCctK(text: string): number[] {
  return numbersWithUnit(text, ["k"], 1000, 10_000);
}

/**
 * CRI, 50–100: "Ra>90", ">90", "CRI 90", "Ra≥80". An R-value ("R9>50") is a
 * different metric and is ignored.
 */
export function parseCri(text: string): number[] {
  const withoutRValues = text.replace(/\bR\d+\s*[<>=≤≥]*\s*\d+/gi, " ");
  return numbersWithUnit(withoutRValues, ["ra", "min"], 50, 100);
}

/** Beam angle in degrees, 1–360: "24°", "15°/24°/36°", "24 deg". */
export function parseBeamDeg(text: string): number[] {
  // For beams "15x45°" is a pair of angles (an oval beam), not a count, so
  // the "x" becomes a list gap and both numbers share the "°".
  const pairs = text.replace(TIMES_BETWEEN, "/");
  return numbersWithUnit(pairs, ["°", "deg", "degree", "degrees"], 1, 360);
}

/** UGR, 0–40: "<19", "UGR<16", "UGR≤22". */
export function parseUgr(text: string): number[] {
  return numbersWithUnit(text, ["max"], 0, 40);
}

/** Wattage, 0.1–2000 W: "10W", "7W/10W", "10±1W" (tolerance dropped), "10". */
export function parseWattage(text: string): number[] {
  return numbersWithUnit(text, ["w"], 0.1, 2000);
}

/** IP rating as its two digits: "IP20" → 20, "IP65" → 65. "IPX4" has none. */
export function parseIp(text: string): number[] {
  const values = [...text.matchAll(/\bIP\s*([0-6])([0-9])(?![0-9])/gi)].map(
    (match) => Number(`${match[1]}${match[2]}`),
  );
  return [...new Set(values)];
}

const PARSERS: Record<FilterKey, (text: string) => number[]> = {
  cctK: parseCctK,
  cri: parseCri,
  beamDeg: parseBeamDeg,
  ugr: parseUgr,
  wattage: parseWattage,
  ip: parseIp,
};

/* ---------------------------------------------------------------------------
 * Entry points.
 * ------------------------------------------------------------------------- */

/** The filter numbers of one cleaned spec cell. */
export interface FilterNumbers {
  /** The filter this spec key feeds, or null when it feeds none. */
  filter: FilterKey | null;
  numbers: number[];
  warnings: ImportWarning[];
}

/**
 * Parses one cleaned cell (its options, or null when not applicable) of a
 * spec key. Keys without a filter (e.g. lumenEfficiency "95±") give no
 * numbers and no warning. An option with text that yields no number gets
 * `unparsed_filter_value`; its display string is kept by the caller.
 */
export function parseFilterNumbers(
  key: SpecKey,
  options: readonly string[] | null,
  at: CellAt,
): FilterNumbers {
  const filter = FILTER_KEY_BY_SPEC[key] ?? null;
  if (filter === null || options === null) {
    return { filter, numbers: [], warnings: [] };
  }
  const warnings: ImportWarning[] = [];
  const numbers: number[] = [];
  for (const option of options) {
    const found = PARSERS[filter](option);
    if (found.length === 0 && option.trim() !== "") {
      warnings.push(
        importWarning("unparsed_filter_value", {
          ...at,
          column: key,
          detail: `No number could be read from "${option}" for the filter; the text is still shown on the product page.`,
        }),
      );
    }
    numbers.push(...found);
  }
  return { filter, numbers: [...new Set(numbers)], warnings };
}

/**
 * A product's filter numbers: the union over its product-level specs and
 * every variant's specs, deduped, sorted ascending and capped at
 * MAX_FILTER_VALUES per filter (values above MAX_FILTER_NUMBER dropped).
 * Filters with no numbers are left out.
 *
 * This does NOT remove the filters of restricted columns: that needs the
 * column-visibility setting from the database. The import's plan step (T7)
 * must pass the result through `withoutRestrictedFilters`
 * (src/lib/admin/products.ts) before saving, so a restricted column never
 * gets filter numbers (CLAUDE.md security rule 9, ADR 0002).
 */
export function filtersFromSpecs(
  specsList: readonly SpecValues[],
): ProductFilters {
  const union = new Map<FilterKey, Set<number>>();
  for (const specs of specsList) {
    for (const key of SPEC_KEYS) {
      const filter = FILTER_KEY_BY_SPEC[key];
      const options = specs[key];
      if (filter === undefined || options === undefined) continue;
      const set = union.get(filter) ?? new Set<number>();
      for (const option of options) {
        for (const n of PARSERS[filter](option)) set.add(n);
      }
      union.set(filter, set);
    }
  }
  const filters: ProductFilters = {};
  for (const [filter, set] of union) {
    const sorted = [...set]
      .filter((n) => n >= 0 && n <= MAX_FILTER_NUMBER)
      .sort((a, b) => a - b)
      .slice(0, MAX_FILTER_VALUES);
    if (sorted.length > 0) filters[filter] = sorted;
  }
  return filters;
}
