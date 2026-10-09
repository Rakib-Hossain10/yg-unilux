"use client";

// Filter result crossfade (Phase 4b L7): the results half of a listing page
// (cards, pagination or the empty state) crossfades when a filter, a chip,
// "Clear all" or the sort changes the listing.

/*
 * A React <ViewTransition> whose `update` class is set only for the render
 * that brings refined results (the flag in filter-transition.ts, raised by
 * the filter form, the sort select and RefineLink). Every other transition
 * (pagination, back/forward, a route change, a revalidation, the card ->
 * product morph) leaves it alone (`default="none"`). It renders no DOM of
 * its own, so the server HTML is the same with or without it; it wraps ONE
 * element (the results <section>, a Server Component passed as children) so
 * React names exactly one snapshot.
 *
 * The cards' shared-element boundaries (ProductImageTransition, update
 * "none") get no name during this update, so the whole results block is one
 * picture that crossfades (CSS in listing-motion.css). Without the App
 * Router's React (unit tests) the children render on their own.
 */

import * as React from "react";
import { type ReactNode, useEffect, useLayoutEffect } from "react";

import {
  endListingRefine,
  isListingRefinePending,
  resetListingRefine,
} from "./filter-transition";

const ViewTransition = (
  React as { ViewTransition?: typeof React.ViewTransition }
).ViewTransition;

/** The view-transition class of the results block (CSS hook). */
export const LISTING_RESULTS_CLASS = "listing-results";

export function ListingResultsTransition({
  children,
}: {
  /** One element: the results section. */
  children: ReactNode;
}) {
  // Read (never written) during render: true only while a refinement the
  // visitor started is on its way, so only that commit gets the class.
  const refining = isListingRefinePending();

  // The refined results are committed (layout effects run inside the view
  // transition's update, after the class was read): lower the flag.
  useLayoutEffect(() => {
    if (refining) endListingRefine();
  });
  // Leaving the listing drops anything still raised.
  useEffect(() => resetListingRefine, []);

  if (!ViewTransition) return <>{children}</>;
  return (
    <ViewTransition
      update={refining ? LISTING_RESULTS_CLASS : "none"}
      default="none"
    >
      {children}
    </ViewTransition>
  );
}
