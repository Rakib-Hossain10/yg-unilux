// Unit tests for the browser side of direct image uploads: the checks before
// signing, Cloudinary's answer, progress percents and preview URLs.

import { describe, expect, it } from "vitest";

import {
  CATEGORY_COVER_FORMATS,
  CATEGORY_ICON_FORMATS,
  MAX_IMAGE_BYTES,
} from "@/lib/constants";

import {
  CATEGORY_COVER_RULES,
  CATEGORY_ICON_RULES,
  checkImageFile,
  formatBytes,
  IMAGE_ACCEPT,
  previewUrl,
  progressPercent,
  readUploadResponse,
  singleImageRulesText,
  UPLOAD_FAILED,
  UPLOAD_MISMATCH,
} from "./image-upload";

const ID =
  "yg/products/0123456789abcdef01234567/0f8fad5b-d9cb-469f-a165-70867728950e";

describe("checkImageFile", () => {
  it.each(["image/jpeg", "image/png", "image/webp", "image/avif"])(
    "accepts %s up to the limit",
    (type) => {
      expect(
        checkImageFile({ name: "a", size: MAX_IMAGE_BYTES, type }),
      ).toBeNull();
    },
  );

  it.each(["image/gif", "image/svg+xml", "application/pdf", ""])(
    "refuses %s with a plain message naming the file",
    (type) => {
      expect(checkImageFile({ name: "logo.x", size: 10, type })).toBe(
        "logo.x is not a JPG, PNG, WebP or AVIF image.",
      );
    },
  );

  it("refuses a file over 10 MB, saying its size and the limit", () => {
    expect(
      checkImageFile({
        name: "big.jpg",
        size: MAX_IMAGE_BYTES + 1,
        type: "image/jpeg",
      }),
    ).toBe("big.jpg is 10.1 MB. The limit is 10 MB.");
    expect(
      checkImageFile({
        name: "big.jpg",
        size: 12.5 * 1024 * 1024,
        type: "image/jpeg",
      }),
    ).toBe("big.jpg is 12.5 MB. The limit is 10 MB.");
  });

  it("refuses an empty file", () => {
    expect(checkImageFile({ name: "e.png", size: 0, type: "image/png" })).toBe(
      "e.png is empty.",
    );
  });

  it("offers only the accepted types in the picker", () => {
    expect(IMAGE_ACCEPT).toContain("image/avif");
    expect(IMAGE_ACCEPT).not.toContain("gif");
  });
});

describe("formatBytes and progressPercent", () => {
  it("formats sizes", () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(640 * 1024)).toBe("640 KB");
    expect(formatBytes(10)).toBe("1 KB");
    // Just under 1 MB rounds up to "1 MB", not "1024 KB".
    expect(formatBytes(1024 * 1024 - 1)).toBe("1 MB");
  });

  it("gives whole percents clamped to 0..100", () => {
    expect(progressPercent(45, 100)).toBe(45);
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(200, 100)).toBe(100);
  });
});

describe("readUploadResponse", () => {
  it("accepts a 200 whose public_id is the signed one", () => {
    expect(
      readUploadResponse(200, JSON.stringify({ public_id: ID }), ID),
    ).toEqual({ ok: true });
  });

  it("refuses a 200 with another public_id or none", () => {
    for (const body of [
      JSON.stringify({ public_id: `${ID}x` }),
      JSON.stringify({}),
      "not json",
    ]) {
      expect(readUploadResponse(200, body, ID)).toEqual({
        ok: false,
        message: UPLOAD_MISMATCH,
      });
    }
  });

  it("passes Cloudinary's error message on, cut to 200 characters", () => {
    expect(
      readUploadResponse(
        400,
        JSON.stringify({
          error: { message: "Image file format gif not allowed" },
        }),
        ID,
      ),
    ).toEqual({
      ok: false,
      message: "Upload refused: Image file format gif not allowed",
    });
    const long = readUploadResponse(
      400,
      JSON.stringify({ error: { message: "x".repeat(500) } }),
      ID,
    );
    expect(long.ok === false && long.message.length).toBe(
      "Upload refused: ".length + 200,
    );
  });

  it("gives a plain message for an error without a body", () => {
    expect(readUploadResponse(0, "", ID)).toEqual({
      ok: false,
      message: UPLOAD_FAILED,
    });
  });
});

describe("previewUrl", () => {
  it("builds a fitted, auto-format URL on res.cloudinary.com", () => {
    expect(previewUrl("demo", ID)).toBe(
      `https://res.cloudinary.com/demo/image/upload/c_limit,w_480,h_480,f_auto,q_auto/${ID}`,
    );
  });

  it("asks for a PNG copy when told to (category icons: never SVG)", () => {
    expect(previewUrl("demo", ID, 320, "png")).toBe(
      `https://res.cloudinary.com/demo/image/upload/c_limit,w_320,h_320,f_png,q_auto/${ID}`,
    );
  });

  it("gives no URL without a valid cloud name", () => {
    expect(previewUrl(null, ID)).toBeNull();
    expect(previewUrl("evil.com/x", ID)).toBeNull();
  });
});

describe("category image rules", () => {
  it("lets an icon be PNG, SVG or WebP, nothing else", () => {
    for (const type of ["image/png", "image/svg+xml", "image/webp"]) {
      expect(
        checkImageFile({ name: "i", size: 100, type }, CATEGORY_ICON_RULES),
      ).toBeNull();
    }
    for (const type of ["image/jpeg", "image/avif", "text/html"]) {
      expect(
        checkImageFile({ name: "i", size: 100, type }, CATEGORY_ICON_RULES),
      ).toBe("i is not a PNG, SVG or WebP image.");
    }
    expect(CATEGORY_ICON_RULES.accept).toContain("image/svg+xml");
  });

  it("lets a cover be JPG, PNG or WebP, never SVG", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp"]) {
      expect(
        checkImageFile({ name: "c", size: 100, type }, CATEGORY_COVER_RULES),
      ).toBeNull();
    }
    expect(
      checkImageFile(
        { name: "c", size: 100, type: "image/svg+xml" },
        CATEGORY_COVER_RULES,
      ),
    ).not.toBeNull();
    expect(CATEGORY_COVER_RULES.accept).not.toContain("svg");
  });

  it("keeps the same 10 MB cap and says so in the help text", () => {
    expect(
      checkImageFile(
        { name: "big", size: MAX_IMAGE_BYTES + 1, type: "image/png" },
        CATEGORY_ICON_RULES,
      ),
    ).toMatch(/limit is 10 MB/);
    expect(singleImageRulesText(CATEGORY_ICON_RULES)).toBe(
      "PNG, SVG or WebP, up to 10 MB.",
    );
  });
});

describe("category rules match the server's format lists", () => {
  // Cloudinary format name -> the MIME type a browser reports.
  const MIME: Record<string, string> = {
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
  };
  it.each([
    ["icon", CATEGORY_ICON_RULES, CATEGORY_ICON_FORMATS],
    ["cover", CATEGORY_COVER_RULES, CATEGORY_COVER_FORMATS],
  ] as const)("%s", (_slot, rules, formats) => {
    expect(Object.keys(rules.types).sort()).toEqual(
      formats.map((f) => MIME[f]).sort(),
    );
  });
});
