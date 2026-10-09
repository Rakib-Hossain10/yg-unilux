"use client";

// Filter result settle-in (Phase 4b L7): the results half of a listing page
// (cards, pagination or the empty state) settles in when a filter, a chip,
// "Clear all" or the sort changes the listing.

/*
 * Why the live element and not a view transition: while a view transition
 * runs, Chromium does not hit-test the elements it captured, so for the
 * ~0.4 s of a results crossfade a mouse click or a tap on a new card landed
 * on the grid container and was lost (QA, keyboard was fine). Here the new
 * results are the real DOM from the first frame: they fade and rise in with
 * the Web Animations API (opacity + transform only), and every card is
 * clickable throughout.
 *
 * Only the render that brings refined results animates (the flag in
 * filter-transition.ts, raised by the filter form, the sort select and
 * RefineLink); pagination, back/forward, a route change, a revalidation and
 * the card -> product morph are left alone. The flag is never raised under
 * reduced motion or from the mobile filter sheet, so those swap at once.
 *
 * It renders no DOM of its own (it only attaches a ref to its ONE child, the
 * results <section>), so the server HTML is the same with or without it.
 */

import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";

import { prefersReducedMotion } from "../product/reduced-motion";
import {
  endListingRefine,
  isListingRefinePending,
  resetListingRefine,
} from "./filter-transition";

/** The Web Animations id of the settle-in (tests and re-runs find it). */
export const LISTING_RESULTS_ANIMATION_ID = "listing-results-in";

const SETTLE_KEYFRAMES: Keyframe[] = [
  { opacity: 0, transform: "translateY(0.5rem)" },
  { opacity: 1, transform: "none" },
];
const SETTLE_MS = 340;
/* Same curve as --ease-calm (globals.css). */
const SETTLE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/** Runs the settle-in on `element`, replacing one still running. */
export function settleResults(element: HTMLElement | null): void {
  if (!element || typeof element.animate !== "function") return;
  if (prefersReducedMotion()) return;
  for (const animation of element.getAnimations()) {
    if (animation.id === LISTING_RESULTS_ANIMATION_ID) animation.cancel();
  }
  element.animate(SETTLE_KEYFRAMES, {
    id: LISTING_RESULTS_ANIMATION_ID,
    duration: SETTLE_MS,
    easing: SETTLE_EASING,
    // No fill after the end: nothing stays on the element once it settles.
    fill: "backwards",
  });
}

export function ListingResultsTransition({
  children,
}: {
  /** One element: the results section. */
  children: ReactNode;
}) {
  // The results element, through its (stable) state setter as a callback
  // ref: render never reads a ref object.
  const [section, setSection] = useState<HTMLElement | null>(null);
  // Read (never written) during render: true only while a refinement the
  // visitor started is on its way, so only that commit animates.
  const refining = isListingRefinePending();

  // The refined results are in the DOM (before paint): lower the flag and
  // start the settle-in from the first frame they show.
  useLayoutEffect(() => {
    if (!refining) return;
    endListingRefine();
    settleResults(section);
  });
  // Leaving the listing drops anything still raised.
  useEffect(() => resetListingRefine, []);

  if (!isValidElement(children)) return <>{children}</>;
  return cloneElement(children as ReactElement<{ ref?: Ref<HTMLElement> }>, {
    ref: setSection,
  });
}
