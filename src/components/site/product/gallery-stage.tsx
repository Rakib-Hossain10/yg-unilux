// The product block's image area: the interactive gallery (P6) when the
// product has images, otherwise the neutral placeholder in the same fixed
// 4:3 frame. Server Component; only <Gallery> and its lightbox are client.

import { ProductImageTransition } from "@/components/motion/product/product-image-transition";

import { Gallery } from "./gallery";
import type { GalleryImage } from "./gallery-images";
import { ImagePlaceholder } from "./image-placeholder";

export function GalleryStage({
  images,
  productName,
  productId,
}: {
  /** Display order (photos, then drawings); empty = placeholder. */
  images: readonly GalleryImage[];
  productName: string;
  /** Names the stage frame for the listing -> product morph (P8). */
  productId?: string;
}) {
  return (
    // Stable hook for the gallery tests and the motion pass (plan P6/P8).
    <div data-slot="product-gallery" className="product-gallery">
      {images.length > 0 ? (
        <Gallery
          images={images}
          productName={productName}
          productId={productId}
        />
      ) : productId ? (
        <ProductImageTransition productId={productId}>
          <div className="relative aspect-[4/3] w-full overflow-hidden bg-grey-100">
            <ImagePlaceholder name={productName} />
          </div>
        </ProductImageTransition>
      ) : (
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-grey-100">
          <ImagePlaceholder name={productName} />
        </div>
      )}
    </div>
  );
}
