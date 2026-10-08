// Unit tests for LightboxBoundary (QA gate C L-3): a failed lightbox chunk
// renders nothing and tells the gallery once, instead of taking the product
// page to the error page. The test environment has no DOM, so the boundary's
// React lifecycle methods are exercised directly.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LightboxBoundary } from "./lightbox-boundary";

const child = createElement("dialog", { "data-lightbox": "" }, "Lightbox");

describe("LightboxBoundary", () => {
  it("renders its children while nothing failed", () => {
    const html = renderToStaticMarkup(
      createElement(LightboxBoundary, { onError: vi.fn() }, child),
    );
    expect(html).toBe('<dialog data-lightbox="">Lightbox</dialog>');
  });

  it("is a React error boundary that switches to the failed state", () => {
    expect(LightboxBoundary.getDerivedStateFromError()).toEqual({
      failed: true,
    });
  });

  it("renders nothing once failed and calls onError once per failure", () => {
    const onError = vi.fn();
    const boundary = new LightboxBoundary({ onError, children: child });
    expect(boundary.render()).toBe(child);

    boundary.state = LightboxBoundary.getDerivedStateFromError();
    boundary.componentDidCatch();
    expect(boundary.render()).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("starts clean when mounted again after a failure (the retry)", () => {
    const fresh = new LightboxBoundary({ onError: vi.fn(), children: child });
    expect(fresh.state).toEqual({ failed: false });
    expect(fresh.render()).toBe(child);
  });
});
