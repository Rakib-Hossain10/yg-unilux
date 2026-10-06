// Which product fields have an input on screen. Server and client errors for
// any other field (variants, specs ... until T10b adds their editors) go to the
// form-level alert instead of vanishing. Pure, so the mapping is unit-tested.

/** Section (a) "Basics": plain text inputs. */
export const BASICS_FIELDS = [
  "name",
  "slug",
  "family",
  "modelCode",
  "productNo",
  "type",
  "description",
] as const;

/** Section (a) "Categories and areas" (trackSize only when shown). */
export const CATEGORY_FIELDS = [
  "mainCategory",
  "extraCategories",
  "areas",
] as const;

const ALWAYS = new Set<string>([...BASICS_FIELDS, ...CATEGORY_FIELDS]);

/**
 * True when `field` (a path from formFieldForPath) is rendered right now.
 * T10b adds its sections here (specs.*, variants.N.*, extraSpecs.N.*,
 * publicFiles.N.*).
 */
export function isRenderedField(
  field: string,
  shown: { trackSize: boolean },
): boolean {
  if (ALWAYS.has(field)) return true;
  if (field === "trackSize") return shown.trackSize;
  return /^filters\.[A-Za-z]+$/.test(field);
}
