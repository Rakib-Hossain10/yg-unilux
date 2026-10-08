// The visitor's motion setting for the product-page motion pass (P8).
// Every enhancement checks it at the moment it would run, so a setting
// changed while the page is open applies to the next interaction.

import { useSyncExternalStore } from "react";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** True when motion should be skipped (also when matchMedia is missing). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/*
 * The server and the first client render assume reduced motion, so nothing
 * motion-only is ever in the server HTML; the real value follows hydration.
 */
const serverSnapshot = () => true;

/** The motion setting as React state (re-renders when it changes). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, serverSnapshot);
}
