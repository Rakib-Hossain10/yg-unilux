"use client";

// Error boundary around the lazily loaded lightbox (QA gate C L-3). If the
// lightbox chunk fails to load (offline, a deploy replaced it), React would
// otherwise send the whole product page to its error page. Here the lightbox
// simply does not open: the boundary renders nothing and tells the gallery,
// which unmounts it and lets a later click try again.

import { Component, type ReactNode } from "react";

interface LightboxBoundaryProps {
  /** Called once per failure; the gallery resets its lightbox state. */
  onError: () => void;
  children?: ReactNode;
}

interface LightboxBoundaryState {
  failed: boolean;
}

export class LightboxBoundary extends Component<
  LightboxBoundaryProps,
  LightboxBoundaryState
> {
  override state: LightboxBoundaryState = { failed: false };

  static getDerivedStateFromError(): LightboxBoundaryState {
    return { failed: true };
  }

  // React already reports the error (console in dev, reportError in prod).
  override componentDidCatch(): void {
    this.props.onError();
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
