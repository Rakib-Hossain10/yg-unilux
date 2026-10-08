"use client";

// A category's mega-menu icon and cover image on its edit page (Phase 4b
// L3), each on the shared single-image uploader: upload straight to
// Cloudinary, the server verifies and saves it at once; remove asks first.
// The icon preview is always a PNG copy: an SVG icon is never shown as SVG.

import {
  setCategoryImageAction,
  signCategoryImageUploadAction,
} from "@/app/admin/categories/actions";
import type { CategoryImageSlot } from "@/lib/schemas/category";

import { CATEGORY_COVER_RULES, CATEGORY_ICON_RULES } from "./image-upload";
import {
  SingleImageUploader,
  type SingleImageText,
} from "./single-image-uploader";

const ICON_TEXT: SingleImageText = {
  heading: "Icon",
  intro:
    "Shown next to the category name in the product menu. Use a simple square icon on a transparent background. It replaces the current one as soon as it has uploaded.",
  noun: "icon",
  article: "an",
  previewAlt: "Current category icon",
  removeDescription:
    "The product menu shows only the category name until you upload a new icon.",
};

const COVER_TEXT: SingleImageText = {
  heading: "Cover image",
  intro:
    "Optional. A wide photo shown at the top of this category's page. It replaces the current one as soon as it has uploaded.",
  noun: "cover image",
  article: "a",
  previewAlt: "Current cover image",
  removeDescription:
    "The category page shows no cover image until you upload a new one.",
};

function CategoryImageUploader({
  categoryId,
  slot,
  storedId,
  cloudName,
}: {
  categoryId: string;
  slot: CategoryImageSlot;
  storedId: string | null;
  cloudName: string | null;
}) {
  const icon = slot === "icon";
  return (
    <SingleImageUploader
      idBase={`category-${slot}`}
      storedId={storedId}
      cloudName={cloudName}
      text={icon ? ICON_TEXT : COVER_TEXT}
      rules={icon ? CATEGORY_ICON_RULES : CATEGORY_COVER_RULES}
      shape={icon ? "square" : "wide"}
      previewFormat={icon ? "png" : "auto"}
      sign={() => signCategoryImageUploadAction({ categoryId, slot })}
      save={(publicId) =>
        setCategoryImageAction({ categoryId, slot, publicId })
      }
    />
  );
}

/** Both uploaders, icon first. Each saves on its own. */
export function CategoryImageUploaders({
  categoryId,
  icon,
  coverImage,
  cloudName,
}: {
  categoryId: string;
  /** Stored public ids, or null. Update after each save (refresh). */
  icon: string | null;
  coverImage: string | null;
  /** For the previews; from the server, never a public env variable. */
  cloudName: string | null;
}) {
  return (
    <>
      <CategoryImageUploader
        categoryId={categoryId}
        slot="icon"
        storedId={icon}
        cloudName={cloudName}
      />
      <CategoryImageUploader
        categoryId={categoryId}
        slot="cover"
        storedId={coverImage}
        cloudName={cloudName}
      />
    </>
  );
}
