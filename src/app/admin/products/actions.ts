"use server";

// Server Actions for the products module: create a draft (T9), save the edit
// form, publish, unpublish and delete (T10), sign and save images (T11b).
// requireAdmin() first → the service with the admin's id → revalidate the
// returned tags → redirect last.

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import type {
  ActionData,
  ActionFailure,
  ActionResult,
} from "@/components/admin/action-result";
import type { SignedImageUpload } from "@/components/admin/image-upload";
import {
  PRODUCTS_PATH,
  productEditPath,
} from "@/components/admin/product-paths";
import { withNotice } from "@/components/admin/save-notice";
import {
  createDraft,
  deleteProduct,
  publishProduct,
  unpublishProduct,
  updateProduct,
} from "@/lib/admin/products";
import { saveProductImages } from "@/lib/admin/product-images";
import { signCloudinaryUpload } from "@/lib/admin/uploads";
import type { ServiceResult } from "@/lib/admin/write-result";
import { requireAdmin } from "@/lib/permissions";
import { revalidateCatalogInAction } from "@/lib/revalidate";

/*
 * Every argument is `unknown`: an action is a public POST endpoint, so the
 * browser can send anything. The service re-parses it with a strict Zod
 * schema (unknown keys refused). The actor id always comes from the session.
 *
 * No try/catch: requireAdmin() and redirect() work by throwing, and catching
 * them would let a non-admin call through (ADR 0024).
 */

/*
 * The client's view of a failed service call. Tags stay on the server;
 * `saved` tells the form the write happened (audit failure) so it does not
 * offer to create the same draft again.
 */
function failure(
  result: ServiceResult<unknown> & { ok: false },
): ActionFailure {
  return { ok: false, errors: result.errors, saved: result.tags.length > 0 };
}

/**
 * Creates a draft product, then opens its edit page (which gives later image
 * and datasheet uploads a stable product id). The edit page reads the fixed
 * "created" notice.
 */
export async function createDraftAction(
  values: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await createDraft(viewer.user.id, values);
  // Both branches: on an audit failure the draft is already saved.
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  redirect(withNotice(productEditPath(result.data.id), "created"));
}

/**
 * Saves the edit form (sent as JSON, re-parsed with productInputSchema by the
 * service), then reloads the same edit page with "updated" or "unchanged".
 * `expectedUpdatedAt` is the version the page loaded; the service refuses the
 * save when the product changed since (stale tab). Status is never changed
 * here. A bad or deleted id is a form error.
 */
export async function updateProductAction(
  id: unknown,
  values: unknown,
  expectedUpdatedAt: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await updateProduct(viewer.user.id, id, values, {
    expectedUpdatedAt,
  });
  revalidateCatalogInAction(result.tags);
  if (!result.ok) {
    /*
     * Saved but not audited: re-render so the page carries the new updatedAt
     * and the form resets to the stored values. Otherwise the next save would
     * be refused as stale and Publish would stay blocked on a "dirty" form.
     */
    if (result.tags.length > 0) refresh();
    return failure(result);
  }
  redirect(
    withNotice(
      productEditPath(result.data.id),
      result.tags.length === 0 ? "unchanged" : "updated",
    ),
  );
}

/*
 * Shared tail of publish/unpublish: they stay on the edit page (the admin
 * keeps the keyboard position), so a write re-renders it with refresh(),
 * because admin reads are uncached. A refusal (publishCheck) writes nothing
 * and comes back as field errors naming what is missing.
 */
function statusResult(
  result: Awaited<ReturnType<typeof publishProduct>>,
): ActionResult {
  revalidateCatalogInAction(result.tags);
  // Tags mean something was written, even when the audit step then failed.
  if (result.tags.length > 0) refresh();
  if (!result.ok) return failure(result);
  return { ok: true };
}

/**
 * Publishes the saved product, or says what is missing (ADR 0019). Refused
 * when the product changed since the page loaded `expectedUpdatedAt`.
 */
export async function publishProductAction(
  id: unknown,
  expectedUpdatedAt: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return statusResult(
    await publishProduct(viewer.user.id, id, { expectedUpdatedAt }),
  );
}

/** Takes the product back to draft (hidden from the site); same version check. */
export async function unpublishProductAction(
  id: unknown,
  expectedUpdatedAt: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  return statusResult(
    await unpublishProduct(viewer.user.id, id, { expectedUpdatedAt }),
  );
}

/**
 * Deletes the product, then goes to the list with a "deleted" notice. When
 * the delete happened but its audit entry failed, the result comes back
 * (saved: true) instead, so the admin sees the warning; no refresh(), since
 * the edit page of a deleted product is a 404.
 */
export async function deleteProductAction(id: unknown): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await deleteProduct(viewer.user.id, id);
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  redirect(withNotice(PRODUCTS_PATH, "deleted"));
}

/**
 * Signs one direct browser upload of a product image (ADR 0045). The server
 * picks the public id under this product's own folder; the browser then posts
 * the file with `fields` straight to Cloudinary. Nothing is written, so the
 * returned tags are empty; they still go through the shared helper.
 */
export async function signProductImageUpload(
  productId: unknown,
): Promise<ActionData<SignedImageUpload>> {
  const viewer = await requireAdmin();
  const result = await signCloudinaryUpload(viewer.user.id, {
    target: "product",
    id: productId,
  });
  revalidateCatalogInAction(result.tags);
  if (!result.ok) return failure(result);
  return { ok: true, data: result.data };
}

/**
 * Saves the images editor's FULL ordered list (`{productId, images}`), after
 * the service verified every new upload. `expectedUpdatedAt` is the version
 * the page holds; a product changed since is refused (ADR 0043). The editor
 * stays on the page: a write re-renders it with refresh(), so the page
 * carries the new images and updatedAt.
 */
export async function saveProductImagesAction(
  input: unknown,
  expectedUpdatedAt: unknown,
): Promise<ActionResult> {
  const viewer = await requireAdmin();
  const result = await saveProductImages(viewer.user.id, input, {
    expectedUpdatedAt,
  });
  revalidateCatalogInAction(result.tags);
  // Tags mean something was written, even when the audit step then failed.
  if (result.tags.length > 0) refresh();
  if (!result.ok) return failure(result);
  return { ok: true };
}
