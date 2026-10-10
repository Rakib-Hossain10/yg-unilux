// Bulk import (T9, ADR 0058): upload a filled template, preview what would
// change, then save it in batches. requireAdmin() first (rule 3; the layout
// doesn't re-run on client navigation). The page only loads the category
// choices and which spec columns are restricted (to mark them in the diff);
// the file, the plan and the results live in the client wizard.

import type { Metadata } from "next";

import { ImportWizard } from "@/components/admin/import/import-wizard";
import { categoryOptions } from "@/components/admin/product-category-options";
import { listCategoryTree } from "@/lib/admin/categories";
import { getColumnVisibility } from "@/lib/column-visibility";
import { requireAdmin } from "@/lib/permissions";

import { pageActor, readAsAdmin } from "../admin-reads";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Import" };

/*
 * The Server Actions of this page run under its maxDuration
 * (route-segment-config/maxDuration.md). One commit batch re-reads and
 * re-parses the whole workbook (up to 30 MB) and uploads up to 20 products'
 * pictures, 4 at a time (ADR 0061). 300 s is the most every Vercel plan
 * allows with fluid compute; batches stay well under it.
 */
export const maxDuration = 300;

export default async function AdminImportPage() {
  const viewer = await requireAdmin();
  const actor = await pageActor(viewer);
  const [tree, visibility] = await Promise.all([
    readAsAdmin(() => listCategoryTree(actor)),
    getColumnVisibility(),
  ]);
  const restrictedColumns = Object.entries(visibility)
    .filter(([, value]) => value === "restricted")
    .map(([key]) => key);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Import products</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Add or update many products at once from an Excel file filled from the
          template. You see every change before anything is saved. New products
          are saved as drafts; publish them from the products list.
        </p>
      </div>
      <ImportWizard
        categories={categoryOptions(tree)}
        restrictedColumns={restrictedColumns}
      />
    </div>
  );
}
