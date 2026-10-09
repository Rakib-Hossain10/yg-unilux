// The "a refinement is on its way" flag for the filter result settle-in
// (Phase 4b L7). Browser code.
//
// Why a flag and not a view-transition type: the listing renders on request,
// and the commit that brings the new results often lands in a later
// transition than the one the type was added to, so the type is lost about
// half the time (seen in e2e). Instead, the code that starts a refinement
// (filter checkbox, sort select, RefineLink) raises this flag right before
// the navigation; ListingResultsTransition reads it while it renders the new
// results, animates that one commit (on the live element, so the cards stay
// clickable) and lowers it. The same flag marks <html data-listing-refine>
// so the CSS keeps the page root out of any view transition React starts
// meanwhile (the page never becomes an untouchable snapshot); the mark stays
// a little longer than the animation and is then removed.

import { prefersReducedMotion } from "../product/reduced-motion";

/** The attribute on <html> while a refinement settle-in may run. */
export const LISTING_REFINE_ATTR = "data-listing-refine";

/** How long the <html> mark outlives the commit (settle-in is 340 ms). */
const MARK_HOLD_MS = 900;

let pending = false;
let markTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * True when a refinement started at `origin` should animate the results:
 * not under reduced motion (the results swap at once then), and not from
 * inside a dialog (the small-screen filter sheet covers the grid, so the
 * settle-in would play unseen; the results simply swap behind the sheet).
 */
export function shouldCrossfade(origin: Element | null): boolean {
  if (prefersReducedMotion()) return false;
  return !origin?.closest("dialog");
}

/** Call right before navigating to a refined listing. */
export function beginListingRefine(origin: Element | null): void {
  if (!shouldCrossfade(origin)) return;
  pending = true;
  clearTimeout(markTimer);
  document.documentElement.setAttribute(LISTING_REFINE_ATTR, "");
}

/** Read while rendering the results: is this render the refined one? */
export function isListingRefinePending(): boolean {
  return pending;
}

/** The refined results committed: lower the flag, drop the mark soon. */
export function endListingRefine(): void {
  if (!pending) return;
  pending = false;
  clearTimeout(markTimer);
  markTimer = setTimeout(() => {
    document.documentElement.removeAttribute(LISTING_REFINE_ATTR);
  }, MARK_HOLD_MS);
}

/** Leaving the listing: nothing may stay raised. */
export function resetListingRefine(): void {
  pending = false;
  clearTimeout(markTimer);
  if (typeof document !== "undefined") {
    document.documentElement.removeAttribute(LISTING_REFINE_ATTR);
  }
}
