"use client";

// The product image lightbox (plan "Gallery spec"): a native modal <dialog>
// (focus trap, Esc, inert page come from the browser), 1x / 2x zoom by button,
// double-tap/double-click and + / − keys, drag or arrow keys to pan.

/*
 * Controlled by the gallery: `index` null = closed. A lazy chunk: the gallery
 * mounts it on the first open (opening at once), then it stays mounted and
 * empty while closed (no image is fetched until it opens); the view inside
 * is keyed by the image, so zoom resets on every image. Closing (button, Esc)
 * always goes through dialog.close(), whose "close" event tells the gallery,
 * which puts focus back on the control that opened it. Hooks for the motion
 * pass: data-slot="lightbox", data-slot="lightbox-frame", data-zoom.
 */

import Image from "next/image";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CloseIcon,
  MinusIcon,
  PlusIcon,
} from "../icons";

import { useExitHold } from "@/components/motion/product/use-exit-hold";

import type { GalleryImage } from "./gallery-images";
import {
  lightboxKeyCommand,
  MAX_ZOOM,
  MIN_ZOOM,
  NO_ZOOM,
  panBy,
  panForKey,
  stepZoom,
  toggleZoomAt,
  type Size,
  type Zoom,
} from "./lightbox-zoom";

/* A move shorter than this is a tap, longer a drag (px). */
const TAP_SLOP = 6;
/* A horizontal drag at 1x longer than this changes the image (px). */
const SWIPE_DISTANCE = 48;
/* Two taps closer than this in time and space are a double-tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE = 30;

/* The close fade in product-motion.css (220 ms) plus a frame of margin. */
const EXIT_HOLD_MS = 260;
const noNavigate = () => undefined;

/*
 * Dark viewing room (ui-reviewer M-7): ink background, paper-coloured
 * controls. The global focus ring takes currentColor, so it shows in paper on
 * ink. Disabled arrows dim to grey-500 (not required to meet contrast, but
 * still visible at 4:1 on ink).
 */
const iconButton =
  "inline-flex size-11 shrink-0 items-center justify-center text-paper transition-colors duration-(--duration-quick) hover:bg-grey-800 aria-disabled:cursor-default aria-disabled:text-grey-500 aria-disabled:hover:bg-transparent";

export function Lightbox({
  images,
  index,
  productName,
  idBase,
  onNavigate,
  onClose,
}: {
  images: readonly GalleryImage[];
  /**
   * Prefix for the dialog's own ids, from the gallery's server-rendered id.
   * The lightbox mounts on first open (lazy chunk), where a fresh useId would
   * depend on what else mounted on the client first.
   */
  idBase: string;
  /** The image shown; null = closed. */
  index: number | null;
  productName: string;
  onNavigate: (index: number) => void;
  /** Called once the dialog has closed (button, Esc). */
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hintId = `${idBase}-hint`;
  const open = index !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // The close button first: Esc and Enter both close from there.
      dialog.querySelector<HTMLElement>("[data-lightbox-close]")?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const requestClose = () => dialogRef.current?.close();
  // Motion pass (P8): while the dialog fades out, the last picture stays
  // (inert, no navigation); reduced motion empties it at once, as before.
  const viewIndex = useExitHold(index, EXIT_HOLD_MS);
  const closing = index === null;

  return (
    <dialog
      ref={dialogRef}
      data-slot="lightbox"
      aria-label={`${productName} images`}
      aria-describedby={hintId}
      onClose={onClose}
      // data-lenis-prevent: wheel/touch stay here if Lenis is added later.
      data-lenis-prevent=""
      className="lightbox fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overscroll-contain bg-ink p-0 text-paper backdrop:bg-ink/60"
    >
      <p id={hintId} className="sr-only">
        Use plus and minus to zoom, the arrow keys to move between images or,
        when zoomed, around the image. Escape closes.
      </p>
      {viewIndex !== null && images[viewIndex] ? (
        <LightboxView
          key={viewIndex}
          images={images}
          index={viewIndex}
          productName={productName}
          inert={closing}
          onNavigate={closing ? noNavigate : onNavigate}
          onRequestClose={requestClose}
        />
      ) : null}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {index !== null ? `Image ${index + 1} of ${images.length}` : ""}
      </p>
    </dialog>
  );
}

interface Gesture {
  pointerId: number;
  startX: number;
  startY: number;
  /** The zoom when the drag started; the pan is applied to it. */
  zoom: Zoom;
  moved: boolean;
}

function LightboxView({
  images,
  index,
  productName,
  inert = false,
  onNavigate,
  onRequestClose,
}: {
  images: readonly GalleryImage[];
  index: number;
  productName: string;
  /** True while the closed dialog fades out (P8): not focusable. */
  inert?: boolean;
  onNavigate: (index: number) => void;
  onRequestClose: () => void;
}) {
  const image = images[index];
  const total = images.length;
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const activePointers = useRef(new Set<number>());
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const lastPointerType = useRef("mouse");

  const zoomed = zoom.scale > MIN_ZOOM;

  const frameSize = (): Size => {
    const frame = frameRef.current;
    return frame
      ? { width: frame.clientWidth, height: frame.clientHeight }
      : { width: 0, height: 0 };
  };

  /* A client point as px from the frame's centre (zoomAt's coordinates). */
  const fromCentre = (clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: clientX - rect.left - rect.width / 2,
      y: clientY - rect.top - rect.height / 2,
    };
  };

  const go = (delta: 1 | -1) => {
    const next = index + delta;
    if (next >= 0 && next < total) onNavigate(next);
  };

  // One window listener while open; reads the latest zoom through the
  // effect event, so it is not re-added on every pan step.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (inert) return;
    if (event.defaultPrevented || event.altKey || event.ctrlKey) return;
    if (event.metaKey) return;
    const frame = frameSize();
    const panned = panForKey(zoom, event.key, frame);
    if (panned) {
      event.preventDefault();
      setZoom(panned);
      return;
    }
    const command = lightboxKeyCommand(event.key);
    if (!command) return;
    event.preventDefault();
    if (command === "zoom-in") setZoom(stepZoom(zoom, 1, frame));
    else if (command === "zoom-out") setZoom(stepZoom(zoom, -1, frame));
    else if (command === "zoom-reset") setZoom(NO_ZOOM);
    else go(command === "next" ? 1 : -1);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    activePointers.current.add(event.pointerId);
    lastPointerType.current = event.pointerType;
    // A second finger is a pinch: the browser's own zoom handles it.
    if (activePointers.current.size > 1) {
      gesture.current = null;
      setDragging(false);
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      zoom,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    current.moved = true;
    if (current.zoom.scale > MIN_ZOOM) {
      setDragging(true);
      setZoom(panBy(current.zoom, { x: dx, y: dy }, frameSize()));
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    activePointers.current.delete(event.pointerId);
    const current = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!current || current.pointerId !== event.pointerId) return null;
    return current;
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = endPointer(event);
    if (!current) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.moved) {
      // A swipe at 1x changes the image, like the page gallery.
      if (
        current.zoom.scale === MIN_ZOOM &&
        Math.abs(dx) > SWIPE_DISTANCE &&
        Math.abs(dx) > Math.abs(dy)
      ) {
        go(dx < 0 ? 1 : -1);
      }
      return;
    }
    // Double-tap on touch and pen (a mouse uses dblclick below).
    if (event.pointerType === "mouse") return;
    const tap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
    const previous = lastTap.current;
    if (
      previous &&
      tap.time - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(tap.x - previous.x, tap.y - previous.y) < DOUBLE_TAP_DISTANCE
    ) {
      lastTap.current = null;
      setZoom(toggleZoomAt(zoom, fromCentre(tap.x, tap.y), frameSize()));
    } else {
      lastTap.current = tap;
    }
  };

  if (!image) return null;

  return (
    <div inert={inert} className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between gap-4 px-2 md:px-6">
        <p className="min-w-0 truncate pl-2 font-display text-xl font-light md:text-2xl">
          {productName}
        </p>
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Zoom out"
            aria-disabled={!zoomed}
            onClick={() => zoomed && setZoom(stepZoom(zoom, -1, frameSize()))}
            className={iconButton}
          >
            <MinusIcon />
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            aria-disabled={zoom.scale >= MAX_ZOOM}
            onClick={() =>
              zoom.scale < MAX_ZOOM && setZoom(stepZoom(zoom, 1, frameSize()))
            }
            className={iconButton}
          >
            <PlusIcon />
          </button>
          <span aria-hidden="true" className="mx-2 h-6 w-px bg-grey-700" />
          <button
            type="button"
            aria-label="Close"
            data-lightbox-close=""
            onClick={onRequestClose}
            className={iconButton}
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      <div
        ref={frameRef}
        data-slot="lightbox-frame"
        data-zoom={zoom.scale}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={endPointer}
        onDoubleClick={(event) => {
          if (lastPointerType.current !== "mouse") return;
          setZoom(
            toggleZoomAt(
              zoom,
              fromCentre(event.clientX, event.clientY),
              frameSize(),
            ),
          );
        }}
        style={{ touchAction: zoomed ? "none" : "pinch-zoom" }}
        className={`relative mx-4 min-h-0 flex-1 overflow-hidden select-none md:mx-8 ${
          zoomed
            ? dragging
              ? "cursor-grabbing"
              : "cursor-grab"
            : "cursor-zoom-in"
        }`}
      >
        <div
          className={`absolute inset-0 ${
            dragging
              ? ""
              : "transition-transform duration-(--duration-quick) ease-(--ease-calm)"
          }`}
          style={{
            transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
          }}
        >
          <Image
            src={image.src}
            alt={image.alt}
            fill
            loading="eager"
            draggable={false}
            // A sharper file once zoomed in (the browser picks from srcset).
            sizes={zoomed ? "200vw" : "100vw"}
            className="pointer-events-none object-contain"
          />
        </div>
      </div>

      <div className="flex h-16 shrink-0 items-center justify-center gap-2">
        {total > 1 ? (
          <>
            <button
              type="button"
              aria-label="Previous image"
              aria-disabled={index === 0}
              onClick={() => go(-1)}
              className={iconButton}
            >
              <ArrowLeftIcon />
            </button>
            <p className="min-w-16 text-center text-sm text-grey-300 tabular-nums">
              {index + 1}
              <span aria-hidden="true"> / </span>
              <span className="sr-only"> of </span>
              {total}
            </p>
            <button
              type="button"
              aria-label="Next image"
              aria-disabled={index === total - 1}
              onClick={() => go(1)}
              className={iconButton}
            >
              <ArrowRightIcon />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
