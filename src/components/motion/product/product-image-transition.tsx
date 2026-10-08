// Listing -> product shared-element morph (P8): the product's stage frame
// carries a view-transition name a listing card will share in Phase 4b.

/*
 * Inert until listings exist: React's <ViewTransition> renders no DOM and
 * only sets the name during a React transition. `default="none"` keeps it out
 * of every unrelated transition (Suspense reveals, the variant switch); only
 * a `share` pair animates, with the "product-image-morph" class (CSS in
 * product-motion.css). A 4b listing card wraps its image in this same
 * component with the same product id, so exactly one element per page has
 * the name: never render it twice for one product on one page.
 * Works in Server and Client Components. The App Router's bundled React
 * has ViewTransition; plain React 19.2 (unit tests) does not, and there the
 * children render on their own (same DOM: the component adds none).
 */

import * as React from "react";
import type { ReactNode } from "react";

const ViewTransition = (
  React as { ViewTransition?: typeof React.ViewTransition }
).ViewTransition;

export const PRODUCT_IMAGE_MORPH_CLASS = "product-image-morph";

/** The shared name for a product's main image (listing card and gallery). */
export function productImageTransitionName(productId: string): string {
  return `product-image-${productId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

export function ProductImageTransition({
  productId,
  children,
}: {
  productId: string;
  children: ReactNode;
}) {
  if (!ViewTransition) return <>{children}</>;
  return (
    <ViewTransition
      name={productImageTransitionName(productId)}
      share={PRODUCT_IMAGE_MORPH_CLASS}
      default="none"
    >
      {children}
    </ViewTransition>
  );
}
