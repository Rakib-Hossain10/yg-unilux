// Unit tests for the product gallery (P6): image order and alt text, the
// variant image lookup, and the server-rendered markup (first image eager with
// high fetch priority, the rest lazy, fixed 4:3 frame, placeholder, single
// image, no lightbox before the first open).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PublicImageView } from "@/lib/catalog/view";

import { galleryImages, imageIndexFor } from "./gallery-images";
import { GalleryStage } from "./gallery-stage";

const img = (
  publicId: string,
  kind: PublicImageView["kind"] = "gallery",
  alt: string | null = null,
): PublicImageView => ({ publicId, alt, order: 0, kind });

const toSrc = (publicId: string) =>
  `https://res.cloudinary.com/demo/image/upload/${publicId}`;

describe("galleryImages", () => {
  it("puts photos first and labels drawings in the alt text", () => {
    const images = galleryImages(
      [
        img("dim", "dimension"),
        img("p1"),
        img("inst", "installation", "Ceiling cut-out"),
        img("p2", "gallery", "Arc in black"),
      ],
      "Arc",
      toSrc,
    );
    expect(images.map((image) => image.publicId)).toEqual([
      "p1",
      "p2",
      "dim",
      "inst",
    ]);
    expect(images.map((image) => image.alt)).toEqual([
      "Arc, image 1 of 4",
      "Arc in black",
      "Arc, image 3 of 4 (dimension drawing)",
      "Ceiling cut-out (installation drawing)",
    ]);
    expect(images[0]?.src).toBe(toSrc("p1"));
  });

  it("numbers only the images that can be shown", () => {
    const images = galleryImages(
      [img("a"), img("skip"), img("b")],
      "Arc",
      (id) => (id === "skip" ? null : toSrc(id)),
    );
    expect(images.map((image) => image.alt)).toEqual([
      "Arc, image 1 of 2",
      "Arc, image 2 of 2",
    ]);
  });

  it("treats a blank alt as missing", () => {
    const [first] = galleryImages([img("a", "gallery", "   ")], "Arc", toSrc);
    expect(first?.alt).toBe("Arc, image 1 of 1");
  });

  it("is empty without a cloud", () => {
    expect(galleryImages([img("a")], "Arc", () => null)).toEqual([]);
  });
});

describe("imageIndexFor", () => {
  const images = [{ publicId: "a" }, { publicId: "b" }];
  it("finds a variant's picture or returns null", () => {
    expect(imageIndexFor(images, "b")).toBe(1);
    expect(imageIndexFor(images, "zzz")).toBeNull();
    expect(imageIndexFor(images, null)).toBeNull();
    expect(imageIndexFor(images, "")).toBeNull();
  });
});

const render = (images: ReturnType<typeof galleryImages>) =>
  renderToStaticMarkup(
    createElement(GalleryStage, { images, productName: "Arc" }),
  );

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];

describe("GalleryStage markup", () => {
  const three = galleryImages([img("a"), img("b"), img("c")], "Arc", toSrc);

  it("renders every slide with alt text, image 1 eager, the rest lazy", () => {
    const html = render(three);
    expect(html).toContain('data-slot="product-gallery"');
    expect(html).toContain('data-slot="gallery-track"');
    expect(html).toContain("aspect-[4/3]");
    const tags = imgTags(html);
    // Three stage slides + three thumbnails.
    expect(tags).toHaveLength(6);
    const stage = tags.slice(0, 3);
    expect(stage[0]).toContain('alt="Arc, image 1 of 3"');
    expect(stage[0]).not.toContain('loading="lazy"');
    // The LCP image: high priority, never lazy; only image 1 gets it.
    expect(stage[0]).toContain('fetchPriority="high"');
    expect(stage[1]).toContain('alt="Arc, image 2 of 3"');
    expect(stage[1]).toContain('loading="lazy"');
    expect(tags.filter((tag) => tag.includes('fetchPriority="high"'))).toEqual([
      stage[0],
    ]);
    expect(stage[2]).toContain('loading="lazy"');
    // Thumbnails are decorative (the button text names them) and lazy.
    for (const thumb of tags.slice(3)) {
      expect(thumb).toContain('alt=""');
      expect(thumb).toContain('loading="lazy"');
    }
    // Images only through next/image: no raw Cloudinary src.
    for (const tag of tags) expect(tag).toMatch(/src="\/_next\/image\?url=/);
  });

  it("shows the counter, controls and thumbnails; only slide 1 is tabbable", () => {
    const html = render(three);
    expect(html).toContain('data-slot="gallery-counter"');
    expect(html).toContain('aria-label="Previous image"');
    expect(html).toContain('aria-label="Next image"');
    expect(html).toContain("Show image 2 of 3");
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    // The lightbox is its own chunk, mounted on the first open: the server
    // HTML has no dialog (and so no lightbox picture is fetched).
    expect(html).not.toContain("<dialog");
  });

  it("a single image has no thumbnails, counter or prev/next", () => {
    const html = render(galleryImages([img("a")], "Arc", toSrc));
    expect(imgTags(html)).toHaveLength(1);
    expect(html).not.toContain('data-slot="gallery-thumbnails"');
    expect(html).not.toContain('data-slot="gallery-counter"');
    expect(html).not.toContain("Next image");
    expect(html).toContain('aria-label="View larger"');
  });

  it("no images: the neutral placeholder in the same frame, no lightbox", () => {
    const html = render([]);
    expect(html).toContain('data-slot="product-gallery"');
    expect(html).toContain("aspect-[4/3]");
    expect(html).toContain("Arc: photo not yet available");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<dialog");
  });
});
