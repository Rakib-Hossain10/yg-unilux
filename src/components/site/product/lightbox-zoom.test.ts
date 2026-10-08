// Unit tests for the lightbox zoom rules (P6): steps, point-anchored zoom,
// pan clamping (never past the frame), arrow-key panning and the key map.

import { describe, expect, it } from "vitest";

import {
  clampZoom,
  lightboxKeyCommand,
  MAX_ZOOM,
  NO_ZOOM,
  PAN_STEP,
  panBy,
  panForKey,
  stepZoom,
  toggleZoomAt,
  zoomAt,
} from "./lightbox-zoom";

const frame = { width: 800, height: 600 };

describe("stepZoom", () => {
  it("goes 1x -> 2x and back, centred, and stops at the ends", () => {
    const in2 = stepZoom(NO_ZOOM, 1, frame);
    expect(in2).toEqual({ scale: 2, x: 0, y: 0 });
    expect(stepZoom(in2, 1, frame)).toBe(in2);
    expect(stepZoom(in2, -1, frame)).toEqual(NO_ZOOM);
    expect(stepZoom(NO_ZOOM, -1, frame)).toBe(NO_ZOOM);
  });

  it("zooming out resets any pan", () => {
    const panned = { scale: 2, x: 120, y: -80 };
    expect(stepZoom(panned, -1, frame)).toEqual(NO_ZOOM);
  });
});

describe("zoomAt / toggleZoomAt", () => {
  it("keeps the tapped point under the finger", () => {
    const point = { x: 100, y: -50 };
    const zoomed = zoomAt(NO_ZOOM, 2, point, frame);
    // The image point at `point` before (100, -50) maps to the same spot.
    expect(100 * zoomed.scale + zoomed.x).toBe(point.x);
    expect(-50 * zoomed.scale + zoomed.y).toBe(point.y);
  });

  it("clamps a point near the edge so no empty space shows", () => {
    const zoomed = zoomAt(NO_ZOOM, 2, { x: 5000, y: -5000 }, frame);
    expect(zoomed).toEqual({ scale: 2, x: -400, y: 300 });
  });

  it("toggles between 1x and the largest step", () => {
    const zoomed = toggleZoomAt(NO_ZOOM, { x: 0, y: 0 }, frame);
    expect(zoomed.scale).toBe(MAX_ZOOM);
    expect(toggleZoomAt(zoomed, { x: 10, y: 10 }, frame)).toEqual(NO_ZOOM);
  });
});

describe("panning", () => {
  it("is a no-op at 1x", () => {
    expect(panBy(NO_ZOOM, { x: 50, y: 50 }, frame)).toBe(NO_ZOOM);
    expect(panForKey(NO_ZOOM, "ArrowLeft", frame)).toBeNull();
  });

  it("is clamped to (scale - 1) * size / 2 each way", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    expect(panBy(zoomed, { x: 9999, y: -9999 }, frame)).toEqual({
      scale: 2,
      x: 400,
      y: -300,
    });
    expect(clampZoom({ scale: 1, x: 3, y: -3 }, frame)).toEqual(NO_ZOOM);
  });

  it("arrow keys pan a fixed share of the frame, in the reading direction", () => {
    const zoomed = { scale: 2, x: 0, y: 0 };
    expect(panForKey(zoomed, "ArrowLeft", frame)?.x).toBe(
      frame.width * PAN_STEP,
    );
    expect(panForKey(zoomed, "ArrowRight", frame)?.x).toBe(
      -frame.width * PAN_STEP,
    );
    expect(panForKey(zoomed, "ArrowUp", frame)?.y).toBe(
      frame.height * PAN_STEP,
    );
    expect(panForKey(zoomed, "ArrowDown", frame)?.y).toBe(
      -frame.height * PAN_STEP,
    );
    expect(panForKey(zoomed, "a", frame)).toBeNull();
  });
});

describe("lightboxKeyCommand", () => {
  it.each([
    ["+", "zoom-in"],
    ["=", "zoom-in"],
    ["-", "zoom-out"],
    ["_", "zoom-out"],
    ["0", "zoom-reset"],
    ["ArrowLeft", "previous"],
    ["ArrowRight", "next"],
    ["Escape", null],
    ["ArrowUp", null],
    ["x", null],
  ])("%s -> %s", (key, command) => {
    expect(lightboxKeyCommand(key)).toBe(command);
  });
});
