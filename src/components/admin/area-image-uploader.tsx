"use client";

// The area's black-and-white image on its edit page (T11b), on the shared
// single-image uploader: preview, upload straight to Cloudinary (the server
// verifies and saves it), or remove it after a confirm.

import {
  setAreaImageAction,
  signAreaImageUpload,
} from "@/app/admin/areas/actions";

import {
  SingleImageUploader,
  type SingleImageText,
} from "./single-image-uploader";

const TEXT: SingleImageText = {
  heading: "Black-and-white image",
  intro:
    "Shown for this area on the site. A new image replaces the current one as soon as it has uploaded.",
  noun: "image",
  article: "an",
  previewAlt: "Current black-and-white image",
  removeDescription:
    "The area shows no black-and-white image on the site until you upload a new one.",
};

export function AreaImageUploader({
  areaId,
  bwImage,
  cloudName,
}: {
  areaId: string;
  /** The stored public id, or null. Updates after each save (refresh). */
  bwImage: string | null;
  /** For the preview; from the server, never a public env variable. */
  cloudName: string | null;
}) {
  return (
    <SingleImageUploader
      idBase="area-image"
      storedId={bwImage}
      cloudName={cloudName}
      text={TEXT}
      sign={() => signAreaImageUpload(areaId)}
      save={(publicId) => setAreaImageAction({ areaId, publicId })}
    />
  );
}
