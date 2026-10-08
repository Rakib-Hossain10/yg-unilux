"use client";

// Optic-switch readout crossfade (P8): the value shown before the switch
// fades up and out on top of the new one, which rises into place. Wraps one
// value leaf of ProductDetailClient (Model No., lumen, efficacy).

/*
 * The old value is an aria-hidden overlay positioned absolutely, so it never
 * takes space (no layout shift) and is removed once its animation ends: the
 * final DOM is the same with and without motion. Under reduced motion (or
 * before hydration) the overlay is never rendered and the new value is shown
 * at once with its static tint (CSS). The caller re-keys this component on
 * every switch that changes the value, which restarts both animations.
 * Only public values pass through here (the variant view, rule 9).
 */

import { useState, type ReactNode } from "react";

import { useReducedMotion } from "./reduced-motion";

export function ValueCrossfade({
  previous,
  children,
}: {
  /** The text shown before the switch; null = nothing to fade out. */
  previous: string | null;
  /** The current value (keeps its own data-field / data-changed hooks). */
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const [faded, setFaded] = useState(false);
  const showOld = previous !== null && !reduced && !faded;
  return (
    <span className="value-crossfade">
      {children}
      {showOld ? (
        <span
          aria-hidden="true"
          data-crossfade-old=""
          className="value-crossfade-old"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setFaded(true);
          }}
        >
          {previous}
        </span>
      ) : null}
    </span>
  );
}
