// The product's SAVED images as choices for a variant's image select, shared
// through context so the memoised variant rows don't need a new prop. Only
// saved images are offered: the server refuses an id the product doesn't have.

import { createContext } from "react";

import { toEditorImages, type StoredImage } from "./images-state";

export interface SavedImageOption {
  publicId: string;
  label: string;
}

const LABEL_ALT_LENGTH = 60;

/** "Image 2: Arc spotlight, black" in display order; long alt text cut. */
export function savedImageOptions(
  stored: readonly StoredImage[],
): SavedImageOption[] {
  return toEditorImages(stored).map((image, index) => {
    // By code point, so an emoji is never cut in half.
    const chars = Array.from(image.alt.trim());
    const short =
      chars.length > LABEL_ALT_LENGTH
        ? `${chars
            .slice(0, LABEL_ALT_LENGTH - 1)
            .join("")
            .trimEnd()}…`
        : chars.join("");
    return {
      publicId: image.publicId,
      label:
        short === "" ? `Image ${index + 1}` : `Image ${index + 1}: ${short}`,
    };
  });
}

/**
 * The options for a select whose current value is `value`. A value that is
 * not among the saved images (removed in another tab) stays selectable as
 * "Image no longer on this product", so the select never silently changes it;
 * the server then explains on save.
 */
export function imageSelectOptions(
  options: readonly SavedImageOption[],
  value: string,
): SavedImageOption[] {
  if (value === "" || options.some((option) => option.publicId === value)) {
    return [...options];
  }
  return [
    ...options,
    { publicId: value, label: "Image no longer on this product" },
  ];
}

export const SavedImagesContext = createContext<readonly SavedImageOption[]>(
  [],
);
