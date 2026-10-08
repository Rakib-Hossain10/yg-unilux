// GET /api/catalog/restricted/[productId]: the restricted spec values and the
// datasheet button state for the product page's client block (ADR 0002,
// 0062, 0063). The ONLY importer of the restricted reader. Every answer is
// per viewer and never cached (`private, no-store`). Never returns a
// datasheet URL, storage key or file name.

import { connection } from "next/server";

import { getPublishedProductRef } from "@/lib/catalog/product-ref";
import { getRestrictedSpecs } from "@/lib/catalog/restricted";
import { datasheetButtonState } from "@/lib/datasheet-state";
import { checkDatasheetAccess, getViewer } from "@/lib/permissions";
import { objectIdSchema } from "@/lib/schemas/common";

// Mongoose and Better Auth need Node APIs.
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

const notFound = () => json({ message: "Product not found." }, 404);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ productId: string }> },
): Promise<Response> {
  await connection();
  const parsed = objectIdSchema.safeParse((await params).productId);
  if (!parsed.success) return json({ message: "Invalid product id." }, 400);
  const productId = parsed.data;

  const [product, viewer] = await Promise.all([
    getPublishedProductRef(productId),
    getViewer(),
  ]);
  if (!product) return notFound();

  const access = checkDatasheetAccess(viewer?.user, new Date());
  const state = datasheetButtonState(access, product.hasDatasheet);
  if (!access.ok) return json({ allowed: false, state });

  // getRestrictedSpecs re-checks the viewer itself (ADR 0063). null here
  // means the product was unpublished or access was revoked in between:
  // fail closed with no restricted data.
  const view = await getRestrictedSpecs(productId);
  if (!view) return notFound();

  return json({
    allowed: true,
    state,
    keys: view.keys,
    specs: view.specs,
    variants: view.variants,
  });
}
