"use client";

// Quiet reveal of the product page's table sections (P8): spec groups and
// the Models table rise and fade in once, as they first scroll into view.

/*
 * Server HTML is final and fully visible: nothing is hidden before this runs.
 * After hydration only the targets that start BELOW the fold are marked
 * (`data-reveal`), so nothing on screen ever disappears; each one is revealed
 * by a CSS transition (opacity + transform) when it enters, and the mark is
 * removed when that transition ends, so the final DOM is the server DOM.
 * Reduced motion: nothing is marked. Unmount (route change) disconnects the
 * observer and clears every mark and inline delay. Renders nothing.
 */

import { useEffect } from "react";

import { prefersReducedMotion } from "./reduced-motion";

/** What reveals: each spec group (not the restricted slot) and the Models table. */
export const PRODUCT_REVEAL_SELECTOR =
  '[data-section="specifications"] > div:not([data-slot]), [data-section="models"]';

/* Targets entering in one batch follow each other by this much (ms). */
const STAGGER_MS = 70;
/* The mark is dropped even if transitionend never fires (ms). */
const REVEAL_FALLBACK_MS = 1200;

export function SectionReveal({
  selector = PRODUCT_REVEAL_SELECTOR,
}: {
  selector?: string;
}) {
  useEffect(() => {
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined")
      return;

    // Reads first (one layout), then writes.
    const fold = window.innerHeight;
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(selector),
    ).filter((element) => element.getBoundingClientRect().top > fold);
    if (targets.length === 0) return;

    const timers = new Set<number>();
    const settle = (element: HTMLElement) => {
      delete element.dataset.reveal;
      element.style.removeProperty("transition-delay");
      // No empty style="" left behind: the final DOM is the server DOM.
      if (element.getAttribute("style") === "")
        element.removeAttribute("style");
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== event.currentTarget) return;
      if (event.propertyName !== "opacity") return;
      const element = event.currentTarget as HTMLElement;
      element.removeEventListener("transitionend", onEnd);
      settle(element);
    };

    const pending = new Set(targets);
    const reveal = (element: HTMLElement, order: number) => {
      pending.delete(element);
      observer.unobserve(element);
      if (order > 0)
        element.style.setProperty(
          "transition-delay",
          `${order * STAGGER_MS}ms`,
        );
      element.addEventListener("transitionend", onEnd);
      element.dataset.reveal = "in";
      const timer = window.setTimeout(
        () => {
          timers.delete(timer);
          element.removeEventListener("transitionend", onEnd);
          settle(element);
        },
        REVEAL_FALLBACK_MS + order * STAGGER_MS,
      );
      timers.add(timer);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        // The furthest target that entered; every target before it in the
        // page (targets are in document order) shows too, so groups jumped
        // over by an anchor link (#models) are never left hidden above.
        let last = -1;
        for (const entry of entries) {
          if (entry.isIntersecting)
            last = Math.max(last, targets.indexOf(entry.target as HTMLElement));
        }
        let order = 0;
        for (const element of targets.slice(0, last + 1)) {
          if (!pending.has(element)) continue;
          reveal(element, order);
          order += 1;
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );

    for (const element of targets) {
      element.dataset.reveal = "";
      observer.observe(element);
    }

    return () => {
      observer.disconnect();
      for (const timer of timers) window.clearTimeout(timer);
      for (const element of targets) {
        element.removeEventListener("transitionend", onEnd);
        settle(element);
      }
    };
  }, [selector]);

  return null;
}
