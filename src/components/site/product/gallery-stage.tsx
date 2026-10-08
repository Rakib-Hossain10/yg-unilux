// The product block's image stage as static HTML: the first image in a fixed
// 4:3 frame (no layout shift, preloaded as the likely LCP element) or the
// neutral placeholder. P6 replaces the inside with the interactive gallery.

import Image from "next/image";

import { ImagePlaceholder } from "./image-placeholder";

export interface StageImage {
  src: string;
  alt: string;
}

export function GalleryStage({
  images,
  productName,
}: {
  /** Absolute image URLs in display order; empty = placeholder. */
  images: readonly StageImage[];
  productName: string;
}) {
  const first = images[0];
  return (
    // Stable hook for the P6 gallery and the motion pass (plan P6/P8).
    <div data-slot="product-gallery" className="product-gallery">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-grey-100">
        {first ? (
          <Image
            src={first.src}
            alt={first.alt}
            fill
            preload
            sizes="(min-width: 1024px) 58vw, 100vw"
            className="object-contain"
          />
        ) : (
          <ImagePlaceholder name={productName} />
        )}
      </div>
    </div>
  );
}
