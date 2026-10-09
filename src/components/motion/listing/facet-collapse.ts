// Long facets (Phase 4b L7, plan Q3): a facet with many values (CCT can have
// up to ~50) shows its first values and keeps the rest behind a native
// <details> "Show n more" disclosure, so it works without JavaScript, is in
// the server HTML from the start (no layout shift after hydration) and the
// hidden boxes still submit with the form.

/** A facet collapses only when it has more values than this. */
export const FACET_COLLAPSE_AT = 8;

/** Values shown before "Show n more" when a facet collapses. */
export const FACET_VISIBLE = 6;

export interface FacetSplit<T> {
  visible: T[];
  /** Behind the disclosure (empty when the facet does not collapse). */
  more: T[];
}

/**
 * Splits a facet's options in display order. Never hides only one or two
 * values: up to FACET_COLLAPSE_AT values all show.
 */
export function splitFacetOptions<T>(options: readonly T[]): FacetSplit<T> {
  if (options.length <= FACET_COLLAPSE_AT) {
    return { visible: [...options], more: [] };
  }
  return {
    visible: options.slice(0, FACET_VISIBLE),
    more: options.slice(FACET_VISIBLE),
  };
}

/** True when any hidden value is checked: the disclosure starts open. */
export function moreHasSelected(
  more: readonly { value: string }[],
  isChecked: (value: string) => boolean,
): boolean {
  return more.some((option) => isChecked(option.value));
}

/** The disclosure's label. */
export function showMoreLabel(count: number): string {
  return `Show ${count} more`;
}
