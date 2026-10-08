// Pure zoom and pan rules of the product lightbox (plan "Gallery spec"):
// 1x / 2x, a point stays under the finger when zooming there, the pan never
// shows past the image frame, and the keyboard pans in fixed steps.

/** The zoom steps, smallest first (+ / − move through them). */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 2;
export const ZOOM_LEVELS: readonly number[] = [MIN_ZOOM, MAX_ZOOM];

/** Scale plus translation in px, applied as translate(x, y) scale(scale). */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

/** Share of the frame one arrow key press pans (when zoomed). */
export const PAN_STEP = 0.15;

const clamp = (value: number, limit: number) =>
  Math.min(limit, Math.max(-limit, value));

/**
 * Keeps the scaled frame covering the viewport: with transform-origin at the
 * centre, the translation may be at most (scale - 1) * size / 2 each way.
 */
export function clampZoom(zoom: Zoom, frame: Size): Zoom {
  const limitX = ((zoom.scale - 1) * frame.width) / 2;
  const limitY = ((zoom.scale - 1) * frame.height) / 2;
  // `+ 0` turns -0 into 0, so a reset compares equal to NO_ZOOM.
  return {
    scale: zoom.scale,
    x: clamp(zoom.x, limitX) + 0,
    y: clamp(zoom.y, limitY) + 0,
  };
}

/**
 * Zoom to `scale` keeping `point` (px from the frame's centre) where it is:
 * the image point under it before stays under it after.
 */
export function zoomAt(
  current: Zoom,
  scale: number,
  point: { x: number; y: number },
  frame: Size,
): Zoom {
  if (scale <= MIN_ZOOM) return NO_ZOOM;
  // Image coordinates (unscaled, from the centre) of the point.
  const imageX = (point.x - current.x) / current.scale;
  const imageY = (point.y - current.y) / current.scale;
  return clampZoom(
    { scale, x: point.x - imageX * scale, y: point.y - imageY * scale },
    frame,
  );
}

/** The next zoom step up (+1) or down (-1), centred on the frame centre. */
export function stepZoom(current: Zoom, direction: 1 | -1, frame: Size): Zoom {
  const index = ZOOM_LEVELS.findIndex((level) => level >= current.scale);
  const at = index < 0 ? ZOOM_LEVELS.length - 1 : index;
  const next =
    ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, at + direction))];
  if (next === undefined || next === current.scale) return current;
  return zoomAt(current, next, { x: 0, y: 0 }, frame);
}

/** Double-tap / double-click: zoom in at the point, or back to 1x. */
export function toggleZoomAt(
  current: Zoom,
  point: { x: number; y: number },
  frame: Size,
): Zoom {
  return current.scale > MIN_ZOOM
    ? NO_ZOOM
    : zoomAt(current, MAX_ZOOM, point, frame);
}

/** Moves the view by a drag delta (px), clamped. */
export function panBy(
  current: Zoom,
  delta: { x: number; y: number },
  frame: Size,
): Zoom {
  if (current.scale <= MIN_ZOOM) return current;
  return clampZoom(
    { ...current, x: current.x + delta.x, y: current.y + delta.y },
    frame,
  );
}

const ARROW_DIRECTION: Record<string, { x: number; y: number }> = {
  // ArrowLeft shows more of the left side: the image moves right.
  ArrowLeft: { x: 1, y: 0 },
  ArrowRight: { x: -1, y: 0 },
  ArrowUp: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: -1 },
};

/** An arrow key's pan when zoomed; null for other keys or at 1x. */
export function panForKey(
  current: Zoom,
  key: string,
  frame: Size,
): Zoom | null {
  const direction = ARROW_DIRECTION[key];
  if (!direction || current.scale <= MIN_ZOOM) return null;
  return panBy(
    current,
    {
      x: direction.x * frame.width * PAN_STEP,
      y: direction.y * frame.height * PAN_STEP,
    },
    frame,
  );
}

/** The keyboard command a key press means in the lightbox, if any. */
export type LightboxKeyCommand =
  "zoom-in" | "zoom-out" | "zoom-reset" | "previous" | "next";

export function lightboxKeyCommand(key: string): LightboxKeyCommand | null {
  switch (key) {
    case "+":
    case "=":
    case "Add":
      return "zoom-in";
    case "-":
    case "_":
    case "Subtract":
      return "zoom-out";
    case "0":
      return "zoom-reset";
    case "ArrowLeft":
      return "previous";
    case "ArrowRight":
      return "next";
    default:
      return null;
  }
}
