"use server";

// Server Actions for the products module. T9: create a draft (name + main
// category) and open its edit page. requireAdmin() first → the T8 service with
// the admin's id → revalidate the returned tags → redirect last (ADR 0035).

import { redirect } from "next/navigation";

import type { ActionResult } from "@/components/admin/action-result";
import { productEditPath } from "@/components/admin/product-paths";
import { withNotice } from "@/components/admin/save-notice";
import { createDraft } from "@/lib/admin/products";
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
function failure(result: ServiceResult<unknown> & { ok: false }): ActionResult {
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
