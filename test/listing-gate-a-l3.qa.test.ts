// QA gate A (Phase 4b, L3): category icon / cover / description. Server
// Actions refuse every non-admin caller before any write or Cloudinary call;
// Zod and server-side verification (ADR 0045) on the service; the REAL
// Next.js cache (test/helpers/next-cache-harness.ts) proves an image write
// expires `categories` and the public tree shows it; icon delivery rules
// (raster only, never f_auto, never inline SVG) as static checks.

import "./helpers/next-als";

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCategory,
  getCategoryForEdit,
  setCategoryImage,
  updateCategory,
} from "@/lib/admin/categories";
import { CATALOG_CACHE_VERSION } from "@/lib/catalog/cache-version";
import { listPublicCategories } from "@/lib/catalog/categories";
import { revalidateCatalogInAction } from "@/lib/revalidate";
import { CategoryModel } from "@/models";
import { AuditLogModel } from "@/models/audit-log";

import { REFUSED_CALLERS, sessionFor } from "./helpers/admin-session";
import { setupMemoryDb } from "./helpers/memory-db";
import { createNextCacheHarness, nextTick } from "./helpers/next-cache-harness";
import { testPublicId } from "./helpers/public-ids";

const cloudinaryMock = vi.hoisted(() => ({
  inspectImage: vi.fn(),
  destroyImage: vi.fn(),
  signImageUpload: vi.fn(),
}));
vi.mock("@/lib/cloudinary", () => cloudinaryMock);

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getSessionFromDb: getSession,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  forbidden: () => {
    throw new Error("FORBIDDEN");
  },
}));

import {
  setCategoryImageAction,
  signCategoryImageUploadAction,
  updateCategoryAction,
} from "@/app/admin/categories/actions";

setupMemoryDb("yg_listing_gate_a_l3_qa");
const harness = createNextCacheHarness();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTOR = new Types.ObjectId().toHexString();
const img = (categoryId: string, n = 0) =>
  testPublicId(n, categoryId, "category");

let main: string;
let other: string;

beforeEach(async () => {
  harness.reset();
  getSession.mockReset();
  cloudinaryMock.inspectImage.mockReset().mockResolvedValue({
    ok: true,
    bytes: 1000,
    format: "png",
    width: 64,
    height: 64,
  });
  cloudinaryMock.destroyImage.mockReset().mockResolvedValue(true);
  cloudinaryMock.signImageUpload
    .mockReset()
    .mockImplementation((publicId: string) => ({
      uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload",
      cloudName: "demo",
      publicId,
      fields: {},
    }));
  await Promise.all([
    CategoryModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  const a = await createCategory(ACTOR, { name: "Spot Lights", parent: null });
  const b = await createCategory(ACTOR, { name: "Pendants", parent: null });
  if (!a.ok || !b.ok) throw new Error("seed failed");
  main = a.data.id;
  other = b.data.id;
});

async function snapshot() {
  const rows = await CategoryModel.find({}).sort({ _id: 1 }).lean();
  return JSON.stringify({ rows, audit: await AuditLogModel.countDocuments() });
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe.each(REFUSED_CALLERS)("as %s", (_who, user, outcome) => {
  beforeEach(() => {
    if (user === null) getSession.mockResolvedValue(null);
    else getSession.mockResolvedValue(sessionFor(user));
  });

  const calls: [string, () => Promise<unknown>][] = [
    [
      "sign icon",
      () => signCategoryImageUploadAction({ categoryId: main, slot: "icon" }),
    ],
    [
      "sign cover",
      () => signCategoryImageUploadAction({ categoryId: main, slot: "cover" }),
    ],
    [
      "set icon",
      () =>
        setCategoryImageAction({
          categoryId: main,
          slot: "icon",
          publicId: img(main, 1),
        }),
    ],
    [
      "set cover",
      () =>
        setCategoryImageAction({
          categoryId: main,
          slot: "cover",
          publicId: img(main, 2),
        }),
    ],
    [
      "clear icon",
      () =>
        setCategoryImageAction({
          categoryId: main,
          slot: "icon",
          publicId: null,
        }),
    ],
    [
      "set description",
      () =>
        updateCategoryAction(main, {
          name: "Spot Lights",
          parent: "",
          description: "Hacked",
        }),
    ],
    ["operator-object input", () => setCategoryImageAction({ $where: "1" })],
  ];

  it.each(calls)(
    "%s is refused before any write or Cloudinary call",
    async (_n, call) => {
      const before = await snapshot();
      await expect(harness.inServerAction(call)).rejects.toThrow(outcome);
      expect(await snapshot()).toBe(before);
      expect(cloudinaryMock.signImageUpload).not.toHaveBeenCalled();
      expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
      expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
    },
  );
});

// ---------------------------------------------------------------------------
// Zod + server-side verification
// ---------------------------------------------------------------------------

describe("setCategoryImage: input validation", () => {
  it.each([
    [
      "raw SVG markup",
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    ],
    ["an SVG data URI", "data:image/svg+xml;base64,PHN2Zz4="],
    ["a URL", "https://evil.example/x.svg"],
    ["a javascript: URL", "javascript:alert(1)"],
    [
      "a path climbing out",
      "yg/categories/../products/0123456789abcdef01234567/00000000-0000-4000-8000-000000000001",
    ],
    ["an uppercase owner id", () => img(main).toUpperCase()],
    ["an id with a transformation", () => `${img(main)}/f_svg`],
    ["an operator object", { $ne: null }],
    ["an array", () => [img(main)]],
  ])("refuses %s, asks Cloudinary nothing", async (_n, raw) => {
    const publicId = typeof raw === "function" ? raw() : raw;
    const before = await snapshot();
    const result = await setCategoryImage(ACTOR, {
      categoryId: main,
      slot: "icon",
      publicId,
    });
    expect(result.ok).toBe(false);
    expect(await snapshot()).toBe(before);
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
  });

  it.each([
    [{ categoryId: { $ne: null }, slot: "icon", publicId: null }],
    [{ categoryId: "x", slot: "icon", publicId: null }],
    [{ categoryId: "", slot: "cover", publicId: null }],
    [{ slot: "icon", publicId: null }],
  ])("refuses a bad category id %j", async (input) => {
    const before = await snapshot();
    expect((await setCategoryImage(ACTOR, input)).ok).toBe(false);
    expect(await snapshot()).toBe(before);
  });

  it.each(["__proto__", "constructor", "coverImage", "icon ", "ICON", ""])(
    "refuses slot %j",
    async (slot) => {
      const result = await setCategoryImage(ACTOR, {
        categoryId: main,
        slot,
        publicId: null,
      });
      expect(result.ok).toBe(false);
    },
  );

  it("refuses extra fields (no mass assignment of name / parent / order)", async () => {
    const before = await snapshot();
    const result = await setCategoryImage(ACTOR, {
      categoryId: main,
      slot: "icon",
      publicId: null,
      name: "X",
      order: -5,
    });
    expect(result.ok).toBe(false);
    expect(await snapshot()).toBe(before);
  });

  it("refuses another category's upload and never deletes it", async () => {
    const theirs = img(other, 9);
    const result = await setCategoryImage(ACTOR, {
      categoryId: main,
      slot: "icon",
      publicId: theirs,
    });
    expect(result.ok).toBe(false);
    expect(cloudinaryMock.inspectImage).not.toHaveBeenCalled();
    expect(cloudinaryMock.destroyImage).not.toHaveBeenCalled();
  });

  it("verifies the upload on the server with the slot's own formats", async () => {
    await setCategoryImage(ACTOR, {
      categoryId: main,
      slot: "icon",
      publicId: img(main, 1),
    });
    expect(cloudinaryMock.inspectImage).toHaveBeenLastCalledWith(img(main, 1), [
      "png",
      "svg",
      "webp",
    ]);
    await setCategoryImage(ACTOR, {
      categoryId: main,
      slot: "cover",
      publicId: img(main, 2),
    });
    expect(cloudinaryMock.inspectImage).toHaveBeenLastCalledWith(img(main, 2), [
      "jpg",
      "png",
      "webp",
    ]);
  });

  it("an SVG is refused as a cover (and the fresh upload removed)", async () => {
    cloudinaryMock.inspectImage.mockResolvedValue({
      ok: false,
      reason: "bad_format",
    });
    const result = await setCategoryImage(ACTOR, {
      categoryId: main,
      slot: "cover",
      publicId: img(main, 3),
    });
    expect(result.ok).toBe(false);
    expect((await getCategoryForEdit(main))?.coverImage).toBeNull();
    expect(cloudinaryMock.destroyImage).toHaveBeenCalledWith(img(main, 3));
  });

  /*
   * FINDING L-1: verification treats any id in the category's folder as a
   * NEW upload. Sending the category's LIVE icon (an SVG) as the cover fails
   * the cover's format list, and verifyUploadedImage then DELETES it from
   * Cloudinary while the category still references it: the mega-menu icon
   * breaks. Same for a live JPG cover sent as the icon (if Cloudinary says
   * "jpg"). Admin-only, but an admin action should never destroy a
   * referenced image. Flip to `it` once ids already stored on the category
   * (either slot) are never destroyed (e.g. check `current` for both fields
   * before verifying, or refuse an id stored in the other slot).
   */
  it.fails(
    "never destroys the category's own live icon when it is sent as the cover",
    async () => {
      const icon = img(main, 4);
      cloudinaryMock.inspectImage.mockResolvedValue({
        ok: true,
        bytes: 500,
        format: "svg",
        width: 64,
        height: 64,
      });
      expect(
        (
          await setCategoryImage(ACTOR, {
            categoryId: main,
            slot: "icon",
            publicId: icon,
          })
        ).ok,
      ).toBe(true);
      cloudinaryMock.inspectImage.mockResolvedValue({
        ok: false,
        reason: "bad_format",
      });
      await setCategoryImage(ACTOR, {
        categoryId: main,
        slot: "cover",
        publicId: icon,
      });
      expect((await getCategoryForEdit(main))?.icon).toBe(icon);
      expect(cloudinaryMock.destroyImage).not.toHaveBeenCalledWith(icon);
    },
  );
});

describe("description", () => {
  it("is plain text: markup is stored verbatim (rendered as text later), capped at 2000", async () => {
    const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const ok = await updateCategory(ACTOR, main, {
      name: "Spot Lights",
      parent: "",
      description: `  ${markup}  `,
    });
    expect(ok.ok).toBe(true);
    expect((await getCategoryForEdit(main))?.description).toBe(markup);

    const tooLong = await updateCategory(ACTOR, main, {
      name: "Spot Lights",
      parent: "",
      description: "x".repeat(2001),
    });
    expect(tooLong.ok).toBe(false);
    for (const bad of [{ $set: "x" }, ["a"], 5]) {
      const result = await updateCategory(ACTOR, main, {
        name: "Spot Lights",
        parent: "",
        description: bad,
      });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
    expect((await getCategoryForEdit(main))?.description).toBe(markup);
  });
});

// ---------------------------------------------------------------------------
// Tags on the real Next.js cache
// ---------------------------------------------------------------------------

describe("cache: an image write expires `categories` (real unstable_cache)", () => {
  it("the public tree is cached, then shows the new icon/cover/description after the write", async () => {
    const before = await harness.inRequest(() => listPublicCategories());
    expect(before.find((c) => c.id === main)).toMatchObject({
      icon: null,
      coverImage: null,
      description: null,
    });
    // A direct DB write (no tag) is NOT seen: the entry really is cached.
    await CategoryModel.updateOne(
      { _id: main },
      { $set: { description: "raw" } },
    );
    await nextTick();
    const cached = await harness.inRequest(() => listPublicCategories());
    expect(cached.find((c) => c.id === main)?.description).toBeNull();

    const result = await harness.inServerAction(async () => {
      const r = await setCategoryImage(ACTOR, {
        categoryId: main,
        slot: "icon",
        publicId: img(main, 5),
      });
      revalidateCatalogInAction(r.tags);
      return r;
    });
    expect(result.ok).toBe(true);
    expect(result.tags).toEqual(["categories"]);
    await nextTick();
    const after = await harness.inRequest(() => listPublicCategories());
    expect(after.find((c) => c.id === main)).toMatchObject({
      icon: img(main, 5),
      description: "raw",
    });
    // Only public fields in the view.
    expect(Object.keys(after[0] ?? {}).sort()).toEqual(
      [
        "coverImage",
        "description",
        "icon",
        "id",
        "name",
        "order",
        "parentId",
        "slug",
      ].sort(),
    );
  });

  it("the cache version is v3 (the view gained icon/cover/description)", () => {
    expect(CATALOG_CACHE_VERSION).toBe("v3");
  });
});

// ---------------------------------------------------------------------------
// Icon delivery: raster only, never f_auto, never inline SVG
// ---------------------------------------------------------------------------

function sources(dir: string): string[] {
  return readdirSync(path.join(root, dir), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (e) =>
        e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name),
    )
    .map((e) => path.join(e.parentPath, e.name));
}

describe("icon delivery rules (static)", () => {
  it("the site image helper never forces f_auto (or any format)", () => {
    const code = readFileSync(
      path.join(root, "src/components/site/cloudinary-image.ts"),
      "utf8",
    );
    expect(code).not.toMatch(/f_auto/);
  });

  it("SVG is never optimised or served by next/image (no dangerouslyAllowSVG)", () => {
    const config = readFileSync(path.join(root, "next.config.ts"), "utf8");
    expect(config).not.toMatch(/dangerouslyAllowSVG/);
  });

  it("no site/app source inlines markup or puts f_auto on a category icon", () => {
    for (const file of [
      ...sources("src/components/site"),
      ...sources("src/app"),
    ]) {
      const code = readFileSync(file, "utf8");
      expect(code, file).not.toMatch(/dangerouslySetInnerHTML/);
      // An icon URL built with f_auto could hand the SVG original to the browser.
      expect(code, file).not.toMatch(
        /icon[^\n]{0,80}f_auto|f_auto[^\n]{0,80}icon/i,
      );
    }
  });
});
