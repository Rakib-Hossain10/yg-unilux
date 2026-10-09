// The Cloudinary delivery URL of a public image, as a pure function with no
// server import, so client components (the search overlay's thumbnails) and
// the server helper (cloudinary-image.ts) build URLs the same way. The cloud
// name is public (it is in every image URL); it is read on the server and
// handed down as a prop, never from a NEXT_PUBLIC_ variable.

/**
 * `https://res.cloudinary.com/<cloud>/image/upload/[<step>/]<publicId>`, or
 * null without a cloud name or public id. `transformation` must come from a
 * fixed list in our code (CLOUDINARY_TRANSFORMS), never from input. This
 * module never asks for an automatic format: an icon may be an SVG original.
 */
export function cloudinaryDeliveryUrl(
  cloudName: string | null,
  publicId: string,
  transformation?: string,
): string | null {
  if (!cloudName || publicId === "") return null;
  const path = publicId.split("/").map(encodeURIComponent).join("/");
  const step = transformation ? `${transformation}/` : "";
  return `https://res.cloudinary.com/${encodeURIComponent(cloudName)}/image/upload/${step}${path}`;
}
