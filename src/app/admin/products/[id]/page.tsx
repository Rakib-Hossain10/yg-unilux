// Edit page for one product (T10a/b, T11b): status and publishing, the
// details form, the images editor (saved on its own) and delete. An unknown or malformed id is a 404. requireAdmin()
// first (rule 3); no loading.tsx here, so not-found can answer before streaming.

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BackLink } from "@/components/admin/back-link";
import {
  categoryOptions,
  magneticTrackIds,
} from "@/components/admin/product-category-options";
import { ImagesEditor } from "@/components/admin/product-form/images-editor";
import { ProductEditForm } from "@/components/admin/product-form/product-edit-form";
import { PRODUCTS_PATH } from "@/components/admin/product-paths";
import { NOTICE_PARAM, readNotice } from "@/components/admin/save-notice";
import { SaveNoticeAlert } from "@/components/admin/save-notice-alert";
import { listAreas } from "@/lib/admin/areas";
import { listCategoryTree } from "@/lib/admin/categories";
import { listDatasheets } from "@/lib/admin/datasheets";
import { getProductForEdit } from "@/lib/admin/products";
import { requireAdmin } from "@/lib/permissions";
import { publishCheck } from "@/lib/schemas/product";

import { adminCloudName } from "../../cloudinary-cloud-name";

// Static only (ADR 0036): never the product's name.
export const metadata: Metadata = { title: "Edit product" };

const NOTICES = {
  created: "Draft created. Fill in the details below, then save.",
  updated: "Product saved.",
  unchanged: "No changes to save.",
  deleted: "Product deleted.",
} as const;

export default async function EditProductPage({
  params,
  searchParams,
}: PageProps<"/admin/products/[id]">) {
  await requireAdmin();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  // The service validates the id; a bad one is simply "not found".
  const [product, tree, areas, datasheets] = await Promise.all([
    getProductForEdit(id),
    listCategoryTree(),
    listAreas(),
    listDatasheets(),
  ]);
  if (!product) notFound();

  const { values } = product;
  const status = values.status ?? "draft";
  // What publishing would refuse right now, from the SAVED product.
  const problems = publishCheck({
    mainCategory: values.mainCategory,
    variants: values.variants ?? [],
    images: product.images,
  }).map((problem) => problem.message);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={PRODUCTS_PATH}>Products</BackLink>
        <h1 className="text-2xl font-semibold">Edit {values.name}</h1>
      </div>

      <SaveNoticeAlert
        notice={readNotice(query[NOTICE_PARAM])}
        messages={NOTICES}
      />

      <ProductEditForm
        product={{
          id: product.id,
          status,
          values,
          updatedAt: product.updatedAt,
        }}
        // Only ids and labels cross to the browser.
        categories={categoryOptions(tree)}
        areas={areas.map((area) => ({ id: area.id, label: area.name }))}
        magneticTrackIds={magneticTrackIds(tree)}
        publishProblems={problems}
        savedImages={product.images}
        // Only ids and file names cross to the browser, never a storage key.
        datasheets={datasheets.map((sheet) => ({
          id: sheet.id,
          label: sheet.fileName,
        }))}
      >
        {/*
         * Rendered after the details form, before Delete, with its own Save:
         * image changes are saved independently, and the details form's Save
         * stays the first "Save" on the page.
         */}
        <ImagesEditor
          productId={product.id}
          version={product.updatedAt}
          stored={product.images}
          cloudName={adminCloudName()}
          published={status === "published"}
        />
      </ProductEditForm>
    </div>
  );
}
