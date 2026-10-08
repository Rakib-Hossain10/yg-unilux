"use client";

// The product gallery (plan "Gallery spec"): a native CSS scroll-snap track
// that swipes with no JS, enhanced with thumbnails, prev/next, a counter kept
// by IntersectionObserver, the optic switch's image jump and the lightbox.

/*
 * Server HTML shows image 1 (eager, fetchpriority=high: the likely LCP) in a
 * fixed 4:3 frame, so nothing shifts on load or hydration. Every other image
 * and thumbnail is lazy; the lightbox code and pictures load on first open.
 * Every image goes through next/image (remotePatterns pinned to our cloud,
 * ADR 0016).
 * Scrolling is instant under prefers-reduced-motion. Hooks for the motion
 * pass (P8): data-slot="gallery-track" / "gallery-thumbnails" /
 * "gallery-counter", data-gallery-slide, data-current.
 */

import Image from "next/image";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  crossfadeJump,
  isCrossfadeJump,
} from "@/components/motion/product/gallery-jump";
import { ProductImageTransition } from "@/components/motion/product/product-image-transition";

import { ArrowLeftIcon, ArrowRightIcon, ExpandIcon } from "../icons";

import { imageIndexFor, type GalleryImage } from "./gallery-images";
import { LightboxBoundary } from "./lightbox-boundary";
import { useOptionalVariantSelection } from "./product-detail-client";

/*
 * The lightbox (dialog, zoom, pan) is its own chunk, fetched when the visitor
 * shows intent (pointer over or focus inside the gallery) and mounted on the
 * first open; it then stays mounted so its close fade can run. Keeps that
 * code off the page's first load (Lighthouse, P9).
 */
const loadLightbox = () => import("./lightbox");
const lazyLightbox = () =>
  lazy(() => loadLightbox().then((module) => ({ default: module.Lightbox })));
let Lightbox = lazyLightbox();
/*
 * React.lazy remembers a failed load for good. After a failure (caught by
 * LightboxBoundary, QA gate C L-3) start a fresh one, so the next open
 * fetches the chunk again instead of failing at once.
 */
const resetLightboxLoader = () => {
  Lightbox = lazyLightbox();
};
const preloadLightbox = () => {
  void loadLightbox().catch(() => undefined);
};

/* A slide this visible in the track is the current one. */
const CURRENT_THRESHOLD = 0.6;
/* Give up waiting for a programmatic scroll to land after this (ms). */
const SCROLL_SETTLE_MS = 1000;

const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const controlButton =
  "inline-flex size-11 shrink-0 items-center justify-center text-ink transition-colors duration-(--duration-quick) hover:bg-grey-100 aria-disabled:cursor-default aria-disabled:text-grey-400 aria-disabled:hover:bg-transparent";

export function Gallery({
  images,
  productName,
  productId,
}: {
  /** At least one image (the server shows the placeholder otherwise). */
  images: readonly GalleryImage[];
  productName: string;
  /** Names the stage for the listing -> product morph (P8); optional. */
  productId?: string;
}) {
  const total = images.length;
  const trackId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbsRef = useRef<HTMLUListElement>(null);
  const [current, setCurrent] = useState(0);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  /* False until the first open: the lightbox chunk is not needed before. */
  const [lightboxMounted, setLightboxMounted] = useState(false);
  /* The control that opened the lightbox; focus goes back to it. */
  const openerRef = useRef<HTMLElement | null>(null);
  /* A programmatic scroll in flight: the counter waits for its target. */
  const pending = useRef<{ index: number; timer: number } | null>(null);

  const clearPending = useCallback(() => {
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = null;
  }, []);

  const slideButton = (index: number) =>
    trackRef.current?.querySelector<HTMLElement>(
      `[data-gallery-slide="${index}"] button`,
    ) ?? null;

  /*
   * Scrolls the track to slide `index` (DOM only). The counter follows when
   * the slide lands (IntersectionObserver), or at once through goTo.
   */
  const scrollToSlide = useCallback(
    (index: number, instant: boolean) => {
      const track = trackRef.current;
      const slide = track?.children[index];
      if (!track || !(slide instanceof HTMLElement)) return;
      if (Math.abs(track.scrollLeft - slide.offsetLeft) < 1) return;
      clearPending();
      pending.current = {
        index,
        timer: window.setTimeout(clearPending, SCROLL_SETTLE_MS),
      };
      const smooth = !instant && !prefersReducedMotion();
      const from = Math.round(
        track.scrollLeft / Math.max(1, slide.offsetWidth),
      );
      const jump = () =>
        track.scrollTo({ left: slide.offsetLeft, behavior: "instant" });
      // Motion pass (P8): a jump past neighbours crossfades the stage in
      // place; next to it, or without the API, the native slide stays.
      if (
        smooth &&
        isCrossfadeJump(from, index) &&
        track.parentElement &&
        crossfadeJump(track.parentElement, jump)
      )
        return;
      track.scrollTo({
        left: slide.offsetLeft,
        behavior: smooth ? "smooth" : "instant",
      });
    },
    [clearPending],
  );

  /** Shows image `target` (clamped) in the stage; for event handlers. */
  const goTo = (target: number, instant = false) => {
    const index = Math.min(total - 1, Math.max(0, target));
    setCurrent(index);
    scrollToSlide(index, instant);
  };

  // The counter and the selected thumbnail follow swipes and scrolls.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || total < 2) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            !entry.isIntersecting ||
            entry.intersectionRatio < CURRENT_THRESHOLD
          )
            continue;
          const index = Number(
            (entry.target as HTMLElement).dataset.gallerySlide,
          );
          const waiting = pending.current;
          if (waiting && waiting.index !== index) continue;
          clearPending();
          setCurrent(index);
        }
      },
      { root: track, threshold: CURRENT_THRESHOLD },
    );
    for (const slide of track.children) observer.observe(slide);
    track.addEventListener("scrollend", clearPending);
    return () => {
      observer.disconnect();
      track.removeEventListener("scrollend", clearPending);
      clearPending();
    };
  }, [total, clearPending]);

  // Keep the selected thumbnail inside the strip's visible part.
  useEffect(() => {
    const strip = thumbsRef.current;
    const thumb = strip?.children[current];
    if (!strip || !(thumb instanceof HTMLElement)) return;
    const left = thumb.offsetLeft;
    const right = left + thumb.offsetWidth;
    const behavior = prefersReducedMotion() ? "instant" : "smooth";
    if (left < strip.scrollLeft) strip.scrollTo({ left, behavior });
    else if (right > strip.scrollLeft + strip.clientWidth)
      strip.scrollTo({ left: right - strip.clientWidth, behavior });
  }, [current]);

  // The optic switch: a variant with its own picture brings it into view.
  // The server shows variant 1 with image 1, so only a change is followed;
  // a ?model= deep link (no switch by the visitor yet) jumps instantly.
  const selection = useOptionalVariantSelection();
  const variantIndex = selection?.index ?? 0;
  const switchedByVisitor = selection?.previous != null;
  const variantImage = imageIndexFor(
    images,
    selection?.variants[variantIndex]?.imagePublicId,
  );
  const followedVariant = useRef(0);
  useEffect(() => {
    if (variantIndex === followedVariant.current) return;
    followedVariant.current = variantIndex;
    if (variantImage !== null) scrollToSlide(variantImage, !switchedByVisitor);
  }, [variantIndex, variantImage, switchedByVisitor, scrollToSlide]);

  const onTrackKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "ArrowLeft"
        ? current - 1
        : event.key === "ArrowRight"
          ? current + 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? total - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    if (next < 0 || next >= total || next === current) return;
    goTo(next);
    slideButton(next)?.focus({ preventScroll: true });
  };

  const openLightbox = (index: number, opener: HTMLElement) => {
    openerRef.current = opener;
    setLightboxMounted(true);
    setLightboxIndex(index);
  };

  /* The chunk failed: no lightbox, the page stays; the next open retries. */
  const onLightboxError = () => {
    resetLightboxLoader();
    setLightboxMounted(false);
    setLightboxIndex(null);
  };

  const onLightboxClose = () => {
    const shown = lightboxIndex;
    setLightboxIndex(null);
    if (shown !== null && shown !== current) goTo(shown, true);
    // Back to the opener; a stage slide hands over to the slide now shown.
    const opener = openerRef.current;
    const target =
      opener?.closest("[data-gallery-slide]") && shown !== null
        ? slideButton(shown)
        : opener;
    target?.focus({ preventScroll: true });
  };

  const several = total > 1;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={`${productName} images`}
      className="gallery"
      onPointerEnter={preloadLightbox}
      onFocus={preloadLightbox}
    >
      <StageTransition productId={productId}>
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-grey-100">
          <div
            ref={trackRef}
            id={trackId}
            data-slot="gallery-track"
            onKeyDown={several ? onTrackKeyDown : undefined}
            className="gallery-track absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain"
          >
            {images.map((image, index) => (
              <div
                key={image.publicId}
                role="group"
                aria-roledescription="slide"
                aria-label={`${index + 1} of ${total}`}
                data-gallery-slide={index}
                data-current={index === current ? "" : undefined}
                className="relative h-full w-full shrink-0 snap-center snap-always"
              >
                <button
                  type="button"
                  tabIndex={index === current ? 0 : -1}
                  onClick={(event) => openLightbox(index, event.currentTarget)}
                  className="gallery-slide-button absolute inset-0 block size-full cursor-zoom-in focus-visible:outline-none"
                >
                  {/* Named "View larger: {alt}" (the text, then the picture). */}
                  <span className="sr-only">View larger: </span>
                  <Image
                    src={image.src}
                    alt={image.alt}
                    fill
                    // Image 1 is the page's LCP: fetched at once with high
                    // priority (no head preload: the <img> is discovered as
                    // early, and Next's docs advise one or the other).
                    loading={index === 0 ? "eager" : "lazy"}
                    fetchPriority={index === 0 ? "high" : undefined}
                    sizes="(min-width: 1440px) 820px, (min-width: 1024px) 58vw, 100vw"
                    className="object-contain"
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      </StageTransition>

      <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        {several ? (
          <ul
            ref={thumbsRef}
            data-slot="gallery-thumbnails"
            aria-label="Choose an image"
            className="gallery-thumbs relative -m-1.5 flex min-w-0 snap-x gap-2 overflow-x-auto p-1.5 md:flex-1"
          >
            {images.map((image, index) => (
              <li key={image.publicId} className="shrink-0 snap-start">
                <button
                  type="button"
                  aria-current={index === current ? "true" : undefined}
                  aria-controls={trackId}
                  data-current={index === current ? "" : undefined}
                  onClick={() => goTo(index)}
                  className="block w-18 border-b-2 border-transparent pb-1.5 transition-colors duration-(--duration-quick) hover:border-grey-300 focus-visible:outline-offset-2 aria-[current=true]:border-ink md:w-20"
                >
                  <span className="relative block aspect-[4/3] bg-grey-100">
                    <Image
                      src={image.src}
                      alt=""
                      fill
                      sizes="80px"
                      className="object-contain"
                    />
                  </span>
                  <span className="sr-only">
                    Show image {index + 1} of {total}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex shrink-0 items-center justify-between gap-4 md:justify-end">
          {several ? (
            <p
              data-slot="gallery-counter"
              className="pl-1 text-sm text-grey-600 tabular-nums"
            >
              <span className="sr-only">Image </span>
              {current + 1}
              <span aria-hidden="true"> / </span>
              <span className="sr-only"> of </span>
              {total}
            </p>
          ) : null}
          <div className="ml-auto flex items-center">
            {several ? (
              <>
                <button
                  type="button"
                  aria-label="Previous image"
                  aria-controls={trackId}
                  aria-disabled={current === 0}
                  onClick={() => current > 0 && goTo(current - 1)}
                  className={controlButton}
                >
                  <ArrowLeftIcon />
                </button>
                <button
                  type="button"
                  aria-label="Next image"
                  aria-controls={trackId}
                  aria-disabled={current === total - 1}
                  onClick={() => current < total - 1 && goTo(current + 1)}
                  className={controlButton}
                >
                  <ArrowRightIcon />
                </button>
              </>
            ) : null}
            <button
              type="button"
              aria-label="View larger"
              // Mid-scroll (an optic switch just jumped the stage), open the
              // image the stage is heading to, not the one it is leaving.
              onClick={(event) =>
                openLightbox(
                  pending.current?.index ?? current,
                  event.currentTarget,
                )
              }
              className={controlButton}
            >
              <ExpandIcon />
            </button>
          </div>
        </div>
      </div>

      {lightboxMounted ? (
        <LightboxBoundary onError={onLightboxError}>
          <Suspense fallback={null}>
            <Lightbox
              images={images}
              index={lightboxIndex}
              productName={productName}
              idBase={trackId}
              onNavigate={setLightboxIndex}
              onClose={onLightboxClose}
            />
          </Suspense>
        </LightboxBoundary>
      ) : null}
    </div>
  );
}

/* The shared-element name only when the product is known (P8). */
function StageTransition({
  productId,
  children,
}: {
  productId?: string;
  children: ReactNode;
}) {
  return productId ? (
    <ProductImageTransition productId={productId}>
      {children}
    </ProductImageTransition>
  ) : (
    children
  );
}
