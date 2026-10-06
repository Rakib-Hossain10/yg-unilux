// Unit and render tests for the product images editor (T11b): list state,
// reorder/remove, save payload, client checks, server error mapping, the
// variant image choices and the editor's markup, all without a browser.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));
vi.mock("@/app/admin/products/actions", () => ({
  signProductImageUpload: vi.fn(),
  saveProductImagesAction: vi.fn(),
}));

import { MAX_IMAGE_ALT_LENGTH, MAX_PRODUCT_IMAGES } from "@/lib/constants";
import { testPublicId } from "../../../../test/helpers/public-ids";

import { ImagesEditor } from "./images-editor";
import {
  buildSavePayload,
  checkImages,
  countText,
  hasUnsavedChanges,
  mapSaveErrors,
  moveImage,
  newImage,
  remainingSlots,
  removeImage,
  toEditorImages,
  unsavedIds,
  updateImage,
  type EditorImage,
} from "./images-state";
import { imageSelectOptions, savedImageOptions } from "./saved-images";

const P = "0123456789abcdef01234567";
const [A, B, C] = [testPublicId(1), testPublicId(2), testPublicId(3)];

const stored = [
  { publicId: B, alt: "Side", order: 1, kind: "dimension" as const },
  { publicId: A, alt: "Front", order: 0, kind: "gallery" as const },
];
const list: EditorImage[] = [
  { publicId: A, alt: "Front", kind: "gallery" },
  { publicId: B, alt: "Side", kind: "dimension" },
];

describe("list state", () => {
  it("reads stored images in display order", () => {
    expect(toEditorImages(stored)).toEqual(list);
  });

  it("a stored image without alt text gets an empty field", () => {
    expect(
      toEditorImages([{ publicId: A, order: 0, kind: "gallery" }])[0]?.alt,
    ).toBe("");
  });

  it("moves an image and leaves the edges alone", () => {
    expect(moveImage(list, 0, "down").map((i) => i.publicId)).toEqual([B, A]);
    expect(moveImage(list, 1, "up").map((i) => i.publicId)).toEqual([B, A]);
    expect(moveImage(list, 0, "up")).toBe(list);
    expect(moveImage(list, 1, "down")).toBe(list);
    expect(moveImage(list, 5, "up")).toBe(list);
  });

  it("removes and updates by public id", () => {
    expect(removeImage(list, A)).toEqual([list[1]]);
    expect(updateImage(list, B, { alt: "Back" })[1]?.alt).toBe("Back");
    expect(updateImage(list, B, { kind: "installation" })[1]?.kind).toBe(
      "installation",
    );
  });

  it("knows what is unsaved: new ids, order, alt, kind", () => {
    expect(hasUnsavedChanges(list, [...list])).toBe(false);
    // Trailing spaces are trimmed on save, so they are not a change.
    expect(
      hasUnsavedChanges(list, updateImage(list, A, { alt: "Front  " })),
    ).toBe(false);
    expect(hasUnsavedChanges(list, moveImage(list, 0, "down"))).toBe(true);
    expect(hasUnsavedChanges(list, updateImage(list, A, { alt: "X" }))).toBe(
      true,
    );
    expect(hasUnsavedChanges(list, [...list, newImage(C)])).toBe(true);
    expect(unsavedIds(list, [...list, newImage(C)])).toEqual(new Set([C]));
  });

  it("counts free slots, uploads in progress included", () => {
    expect(remainingSlots(2, 1)).toBe(MAX_PRODUCT_IMAGES - 3);
    expect(remainingSlots(MAX_PRODUCT_IMAGES, 2)).toBe(0);
    expect(countText(2)).toBe(`2 of ${MAX_PRODUCT_IMAGES} images`);
  });
});

describe("buildSavePayload", () => {
  it("sends the full ordered list with trimmed alt text", () => {
    const payload = buildSavePayload(P, [
      { publicId: B, alt: "  Side ", kind: "dimension" },
      newImage(A),
    ]);
    expect(payload).toEqual({
      productId: P,
      images: [
        { publicId: B, alt: "Side", kind: "dimension" },
        { publicId: A, alt: "", kind: "gallery" },
      ],
    });
  });
});

describe("checkImages", () => {
  it("requires alt text on every card, as the server does", () => {
    const errors = checkImages([
      newImage(A),
      { publicId: B, alt: "   ", kind: "gallery" },
      { publicId: C, alt: "ok", kind: "gallery" },
    ]);
    expect([...errors.keys()]).toEqual([A, B]);
    expect(errors.get(A)?.alt).toBe("Enter alt text");
  });

  it("refuses alt text over the limit", () => {
    const errors = checkImages([
      {
        publicId: A,
        alt: "x".repeat(MAX_IMAGE_ALT_LENGTH + 1),
        kind: "gallery",
      },
    ]);
    expect(errors.get(A)?.alt).toBe(
      `At most ${MAX_IMAGE_ALT_LENGTH} characters`,
    );
  });
});

describe("mapSaveErrors", () => {
  const errors = {
    formErrors: ["This product changed since you opened it."],
    fieldErrors: {
      "images.1.publicId": ["The upload was not found."],
      "images.0.alt": ["Enter alt text"],
      images: ["An image you removed is used by variant AR-1."],
    },
  };

  it("puts card errors on the card that was sent at that position", () => {
    const { cards, messages } = mapSaveErrors(errors, list, list);
    expect(cards.get(B)).toEqual({ publicId: "The upload was not found." });
    expect(cards.get(A)).toEqual({ alt: "Enter alt text" });
    expect(messages).toEqual([
      "This product changed since you opened it.",
      "An image you removed is used by variant AR-1.",
    ]);
  });

  it("sends card errors to the alert when the list changed meanwhile", () => {
    const { cards, messages } = mapSaveErrors(
      errors,
      list,
      moveImage(list, 0, "down"),
    );
    expect(cards.size).toBe(0);
    expect(messages).toContain("Image 2: The upload was not found.");
    expect(messages).toContain("Image 1: Enter alt text");
  });

  it("sends unknown keys to the alert", () => {
    const { messages } = mapSaveErrors(
      { formErrors: [], fieldErrors: { productId: ["Bad id"] } },
      list,
      list,
    );
    expect(messages).toEqual(["Bad id"]);
  });
});

describe("variant image choices", () => {
  it("labels saved images by position and alt text", () => {
    expect(savedImageOptions(stored)).toEqual([
      { publicId: A, label: "Image 1: Front" },
      { publicId: B, label: "Image 2: Side" },
    ]);
    const long = savedImageOptions([
      { publicId: A, alt: "y".repeat(100), order: 0, kind: "gallery" },
    ])[0]?.label;
    expect(long).toBe(`Image 1: ${"y".repeat(59)}…`);
    const spaced = savedImageOptions([
      { publicId: A, alt: `${"y".repeat(58)} zzzz`, order: 0, kind: "gallery" },
    ])[0]?.label;
    expect(spaced).toBe(`Image 1: ${"y".repeat(58)}…`);
    expect(
      savedImageOptions([
        { publicId: A, alt: "  ", order: 0, kind: "gallery" },
      ])[0]?.label,
    ).toBe("Image 1");
  });

  it("keeps a current value that is no longer saved, labelled as such", () => {
    const options = savedImageOptions(stored);
    expect(imageSelectOptions(options, "")).toEqual(options);
    expect(imageSelectOptions(options, A)).toEqual(options);
    expect(imageSelectOptions(options, C).at(-1)).toEqual({
      publicId: C,
      label: "Image no longer on this product",
    });
  });
});

describe("ImagesEditor markup", () => {
  const render = (images = stored, cloudName: string | null = "demo") =>
    renderToStaticMarkup(
      createElement(ImagesEditor, {
        productId: P,
        version: "2026-10-06T12:00:00.000Z",
        stored: images,
        cloudName,
        published: false,
      }),
    );

  it("shows each image in order with labelled alt and kind fields", () => {
    const html = render();
    expect(html.indexOf(A)).toBeLessThan(html.indexOf(B));
    expect(html).toContain(`2 of ${MAX_PRODUCT_IMAGES} images`);
    expect(html).toMatch(/<label[^>]*for="product-image-[^"]+-alt"/);
    expect(html).toMatch(/<label[^>]*for="product-image-[^"]+-kind"/);
    expect(html).toContain(
      `https://res.cloudinary.com/demo/image/upload/c_limit,w_480,h_480,f_auto,q_auto/${A}`,
    );
  });

  it("disables the edge moves with aria-disabled, not disabled", () => {
    const html = render();
    expect(html).toMatch(
      /<button[^>]*aria-label="Move image 1 earlier"[^>]*aria-disabled="true"|<button[^>]*aria-disabled="true"[^>]*aria-label="Move image 1 earlier"/,
    );
    // No button is natively disabled, whatever the attribute order.
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const tag of buttons) expect(tag).not.toMatch(/\sdisabled=""/);
  });

  it("has a polite status region and a Save images button, no form", () => {
    const html = render();
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Save images");
    expect(html).not.toContain("<form");
    expect(html).not.toMatch(/<(input|textarea|select)[^>]*\sname=/);
  });

  it("shows a placeholder without a cloud name, and an empty state", () => {
    expect(render(stored, null)).toContain("Preview unavailable");
    expect(render([])).toContain("No images yet");
  });
});
