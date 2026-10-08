// Gallery crossfade (P8): a jump of more than one slide (thumbnail, variant
// picture) crossfades the stage in place instead of smooth-scrolling past
// every picture in between. Neighbouring slides keep the native slide.

/*
 * Uses the browser's View Transitions API on the stage frame only: the frame
 * gets a view-transition-name for the length of the transition and the page
 * root is not captured (CSS, type "gallery-jump"), so only the 4:3 frame
 * animates, on the compositor (opacity of two snapshots). Returns false, and
 * the caller falls back to its own scroll, when motion is reduced, the API
 * or transition types are missing, or the sticky header overlaps the frame
 * (the snapshot would paint over it).
 */

import { prefersReducedMotion } from "./reduced-motion";

export const GALLERY_JUMP_NAME = "product-gallery-stage";
export const GALLERY_JUMP_TYPE = "gallery-jump";

/** Jumps further than this many slides crossfade instead of sliding. */
export const SLIDE_DISTANCE = 1;

/** True when the jump from `from` to `to` should crossfade. */
export function isCrossfadeJump(from: number, to: number): boolean {
  return Math.abs(to - from) > SLIDE_DISTANCE;
}

function supportsTypedViewTransitions(): boolean {
  return (
    typeof document.startViewTransition === "function" &&
    typeof CSS !== "undefined" &&
    CSS.supports("selector(:active-view-transition-type(a))")
  );
}

/* The sticky site header's bottom edge (0 when there is none). */
function headerBottom(): number {
  const header = document.querySelector("body header");
  return header ? header.getBoundingClientRect().bottom : 0;
}

/**
 * Runs `update` (an instant scroll) inside a crossfade of `frame`.
 * Returns false without running it when the crossfade is not available.
 */
export function crossfadeJump(frame: HTMLElement, update: () => void): boolean {
  if (prefersReducedMotion() || !supportsTypedViewTransitions()) return false;
  if (frame.getBoundingClientRect().top < headerBottom()) return false;

  frame.style.setProperty("view-transition-name", GALLERY_JUMP_NAME);
  const release = () => {
    frame.style.removeProperty("view-transition-name");
    if (frame.getAttribute?.("style") === "") frame.removeAttribute("style");
  };
  try {
    const transition = document.startViewTransition({
      update,
      types: [GALLERY_JUMP_TYPE],
    });
    // A skipped transition (hidden tab, another one started) still runs the
    // update; its rejected promises are expected, not errors.
    transition.ready.catch(() => undefined);
    transition.updateCallbackDone.catch(() => undefined);
    transition.finished.then(release, release);
    return true;
  } catch {
    release();
    return false;
  }
}
