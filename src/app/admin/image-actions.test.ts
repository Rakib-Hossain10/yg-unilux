// Behavioural tests for the image Server Actions (T11b): a visitor, a customer,
// a banned admin and an admin on a temporary password reach no service; the
// admin's calls pass the session's id and the input on, and revalidate.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mongoose } from "@/lib/db";

import { setAreaImageAction, signAreaImageUpload } from "./areas/actions";
import {
  saveProductImagesAction,
  signProductImageUpload,
} from "./products/actions";

const getSession = vi.hoisted(() => vi.fn());
const nextCache = vi.hoisted(() => ({
  updateTag: vi.fn(),
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
}));
const services = vi.hoisted(() => ({
  signCloudinaryUpload: vi.fn(),
  saveProductImages: vi.fn(),
  setAreaImage: vi.fn(),
}));

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
vi.mock("next/cache", () => nextCache);
vi.mock("@/lib/admin/uploads", () => ({
  signCloudinaryUpload: services.signCloudinaryUpload,
}));
vi.mock("@/lib/admin/product-images", () => ({
  saveProductImages: services.saveProductImages,
}));
vi.mock("@/lib/admin/areas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/admin/areas")>()),
  setAreaImage: services.setAreaImage,
}));

const { ObjectId } = mongoose.Types;
const ADMIN_ID = new ObjectId().toHexString();
const PRODUCT_ID = new ObjectId().toHexString();
const AREA_ID = new ObjectId().toHexString();
const PUBLIC_ID = `yg/products/${PRODUCT_ID}/0f8fad5b-d9cb-469f-a165-70867728950e`;
const VERSION = "2026-10-06T12:00:00.000Z";

const SIGNED = {
  uploadUrl: "https://api.cloudinary.com/v1_1/demo/image/upload",
  cloudName: "demo",
  publicId: PUBLIC_ID,
  fields: {
    api_key: "123",
    timestamp: "1",
    public_id: PUBLIC_ID,
    allowed_formats: "jpg,png,webp,avif",
    overwrite: "false",
    signature: "abc",
  },
};

function signedInAs(fields: Record<string, unknown>) {
  getSession.mockResolvedValue({
    session: { id: "s1" },
    user: {
      id: ADMIN_ID,
      email: "someone@example.com",
      role: "admin",
      banned: false,
      banExpires: null,
      mustChangePassword: false,
      accessExpiresAt: null,
      ...fields,
    },
  });
}

const IMAGES = {
  productId: PRODUCT_ID,
  images: [{ publicId: PUBLIC_ID, alt: "Front view", kind: "gallery" }],
};

/* One call of every image action, with input an admin could send. */
const EVERY_ACTION: [string, () => Promise<unknown>][] = [
  ["sign a product upload", () => signProductImageUpload(PRODUCT_ID)],
  ["save product images", () => saveProductImagesAction(IMAGES, VERSION)],
  ["sign an area upload", () => signAreaImageUpload(AREA_ID)],
  [
    "set an area image",
    () => setAreaImageAction({ areaId: AREA_ID, publicId: null }),
  ],
];

beforeEach(() => {
  getSession.mockReset();
  for (const fn of [...Object.values(nextCache), ...Object.values(services)]) {
    fn.mockReset();
  }
});

describe.each([
  ["a visitor", null, "REDIRECT /login"],
  ["a customer", { role: "customer" }, "FORBIDDEN"],
  ["a banned admin", { banned: true }, "FORBIDDEN"],
  [
    "an admin on a temporary password",
    { mustChangePassword: true },
    "REDIRECT /change-password",
  ],
])("as %s", (_who, user, outcome) => {
  beforeEach(() => {
    if (user === null) getSession.mockResolvedValue(null);
    else signedInAs(user);
  });

  it.each(EVERY_ACTION)(
    "%s is refused before any service runs",
    async (_name, call) => {
      await expect(call()).rejects.toThrow(outcome);
      for (const fn of Object.values(services)) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(nextCache.updateTag).not.toHaveBeenCalled();
      expect(nextCache.refresh).not.toHaveBeenCalled();
    },
  );
});

describe("as the admin", () => {
  beforeEach(() => signedInAs({}));

  it("signing a product upload passes the session's id and returns the signature", async () => {
    services.signCloudinaryUpload.mockResolvedValue({
      ok: true,
      data: SIGNED,
      tags: [],
    });
    const result = await signProductImageUpload(PRODUCT_ID);
    expect(services.signCloudinaryUpload).toHaveBeenCalledWith(ADMIN_ID, {
      target: "product",
      id: PRODUCT_ID,
    });
    expect(result).toEqual({ ok: true, data: SIGNED });
    expect(nextCache.updateTag).not.toHaveBeenCalled();
  });

  it("signing for a missing product returns the service's error", async () => {
    services.signCloudinaryUpload.mockResolvedValue({
      ok: false,
      errors: {
        formErrors: ["This product no longer exists."],
        fieldErrors: {},
      },
      tags: [],
    });
    expect(await signProductImageUpload("nope")).toEqual({
      ok: false,
      errors: {
        formErrors: ["This product no longer exists."],
        fieldErrors: {},
      },
      saved: false,
    });
  });

  it("signing an area upload targets the area folder", async () => {
    services.signCloudinaryUpload.mockResolvedValue({
      ok: true,
      data: SIGNED,
      tags: [],
    });
    await signAreaImageUpload(AREA_ID);
    expect(services.signCloudinaryUpload).toHaveBeenCalledWith(ADMIN_ID, {
      target: "area",
      id: AREA_ID,
    });
  });

  it("saving images passes the list and version, revalidates and refreshes", async () => {
    services.saveProductImages.mockResolvedValue({
      ok: true,
      data: { id: PRODUCT_ID, images: [] },
      tags: ["products", `product:${PRODUCT_ID}`],
    });
    expect(await saveProductImagesAction(IMAGES, VERSION)).toEqual({
      ok: true,
    });
    expect(services.saveProductImages).toHaveBeenCalledWith(ADMIN_ID, IMAGES, {
      expectedUpdatedAt: VERSION,
    });
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("an unchanged save refreshes nothing", async () => {
    services.saveProductImages.mockResolvedValue({
      ok: true,
      data: { id: PRODUCT_ID, images: [] },
      tags: [],
    });
    await saveProductImagesAction(IMAGES, VERSION);
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("a refused save returns its field errors, nothing saved", async () => {
    const errors = {
      formErrors: [],
      fieldErrors: { "images.0.alt": ["Enter alt text"] },
    };
    services.saveProductImages.mockResolvedValue({
      ok: false,
      errors,
      tags: [],
    });
    expect(await saveProductImagesAction(IMAGES, VERSION)).toEqual({
      ok: false,
      errors,
      saved: false,
    });
    expect(nextCache.refresh).not.toHaveBeenCalled();
  });

  it("a save whose audit failed reports saved: true and still refreshes", async () => {
    services.saveProductImages.mockResolvedValue({
      ok: false,
      errors: { formErrors: ["audit"], fieldErrors: {} },
      tags: ["products"],
    });
    const result = await saveProductImagesAction(IMAGES, VERSION);
    expect(result).toMatchObject({ ok: false, saved: true });
    expect(nextCache.updateTag).toHaveBeenCalledWith("products");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("setting an area image passes the input on and refreshes", async () => {
    services.setAreaImage.mockResolvedValue({
      ok: true,
      data: { id: AREA_ID, bwImage: null },
      tags: ["areas"],
    });
    const input = { areaId: AREA_ID, publicId: null };
    expect(await setAreaImageAction(input)).toEqual({ ok: true });
    expect(services.setAreaImage).toHaveBeenCalledWith(ADMIN_ID, input);
    expect(nextCache.updateTag).toHaveBeenCalledWith("areas");
    expect(nextCache.refresh).toHaveBeenCalledOnce();
  });

  it("a refused area image returns the publicId error", async () => {
    const errors = {
      formErrors: [],
      fieldErrors: { publicId: ["The upload was not found."] },
    };
    services.setAreaImage.mockResolvedValue({ ok: false, errors, tags: [] });
    expect(
      await setAreaImageAction({ areaId: AREA_ID, publicId: PUBLIC_ID }),
    ).toEqual({ ok: false, errors, saved: false });
  });
});
