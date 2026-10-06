// URL slugs for products, categories and areas: `slugify` turns an English
// name into "arc-ar-013a", `uniqueSlug` adds "-2", "-3" ... until it is free.
// Pure and client-safe (no server-only), so admin forms can preview a slug.

/** URL slugs: lowercase letters and digits in dash-separated words, e.g. "arc-ar-013a". */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Longest slug the models store (the slug field's maxlength). */
export const MAX_SLUG_LENGTH = 120;

/** How many candidates `uniqueSlug` tries by default ("base", then -2 ... -50). */
export const DEFAULT_SLUG_ATTEMPTS = 50;

/*
 * Latin letters that Unicode NFKD does not split into "base letter + accent",
 * so stripping accents alone would drop them. Lowercase only: the input is
 * lowercased first.
 */
const LATIN_EXTRAS: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ı: "i",
};
const LATIN_EXTRAS_PATTERN = new RegExp(
  `[${Object.keys(LATIN_EXTRAS).join("")}]`,
  "g",
);

/**
 * Turns a name into a slug: lowercase ASCII words joined by single hyphens,
 * at most `maxLength` characters, cut at a word boundary where possible.
 *
 * Accents are removed ("Crème" -> "creme"); characters with no ASCII form,
 * such as CJK, are dropped ("Lifud 莱福德" -> "lifud"). Apostrophes join
 * ("Men's" -> "mens"); every other run of non-alphanumerics becomes one
 * hyphen. Returns "" when nothing usable is left, so callers can ask the
 * admin for a slug instead of inventing one.
 */
export function slugify(input: string, maxLength = MAX_SLUG_LENGTH): string {
  const ascii = input
    // NFKD splits "é" into "e" + a combining accent, and maps full-width
    // and compatibility forms ("Ｆ", "Ⅻ") to plain letters.
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(LATIN_EXTRAS_PATTERN, (letter) => LATIN_EXTRAS[letter] ?? "")
    // Straight and curly apostrophes join the word instead of splitting it.
    .replace(/['’]/g, "");

  const slug = ascii.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  return truncateSlug(slug, maxLength);
}

/*
 * Shortens a valid slug to `maxLength`, preferring to cut at the last hyphen
 * so no word is left half-written. A single word longer than the cap is cut
 * hard. Never leaves a trailing hyphen.
 */
function truncateSlug(slug: string, maxLength: number): string {
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  // The next character is a hyphen: the cut already ends on a whole word.
  if (slug[maxLength] === "-") return cut;
  const lastHyphen = cut.lastIndexOf("-");
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/, "");
}

/** `uniqueSlug` could not produce a free slug. */
export class UniqueSlugError extends Error {
  override readonly name = "UniqueSlugError";
}

/**
 * Returns the slug of `base`, or the first of "<slug>-2", "<slug>-3" ... for
 * which `exists` resolves false. Candidates are checked one at a time, at most
 * `maxAttempts` of them, so a pathological collection cannot loop forever.
 *
 * The check-then-insert is not atomic: callers still rely on the unique index
 * and treat a duplicate-key error on insert as "slug taken".
 *
 * Throws UniqueSlugError when `base` has nothing usable in it or every
 * candidate is taken. Errors from `exists` (e.g. the database) pass through.
 */
export async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
  maxAttempts = DEFAULT_SLUG_ATTEMPTS,
): Promise<string> {
  const root = slugify(base);
  if (root === "") {
    throw new UniqueSlugError("The name has no letters or digits for a slug");
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? root : withSuffix(root, attempt);
    if (!(await exists(candidate))) return candidate;
  }
  throw new UniqueSlugError(
    `No free slug after ${maxAttempts} attempts; choose a different slug`,
  );
}

/* "<root>-<n>", shortening the root first so the result stays within the cap. */
function withSuffix(root: string, n: number): string {
  const suffix = `-${n}`;
  return `${truncateSlug(root, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
}
