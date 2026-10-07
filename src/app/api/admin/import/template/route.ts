// GET /api/admin/import/template: the controlled import template (ADR 0059),
// generated per download from the live category tree and areas so the
// dropdowns always match the admin's data. Admin only; never cached.

import { connection } from "next/server";

import { listAreas } from "@/lib/admin/areas";
import {
  listCategoryTree,
  type CategoryTreeNode,
} from "@/lib/admin/categories";
import { buildImportTemplate } from "@/lib/import/template";
import { requireAdminForRoute } from "@/lib/permissions";

// exceljs and the MongoDB driver need Node APIs.
export const runtime = "nodejs";

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILE_NAME = "yg-unilux-import-template.xlsx";

/* The tree as a flat list, each main category followed by its children. */
function flatten(nodes: readonly CategoryTreeNode[]) {
  const flat: { id: string; name: string; parentId: string | null }[] = [];
  for (const node of nodes) {
    flat.push({ id: node.id, name: node.name, parentId: node.parentId });
    flat.push(...flatten(node.children));
  }
  return flat;
}

export async function GET(): Promise<Response> {
  await connection();
  const check = await requireAdminForRoute();
  if (!check.ok) return check.response;

  const [tree, areas] = await Promise.all([listCategoryTree(), listAreas()]);
  const bytes = await buildImportTemplate({
    categories: flatten(tree),
    areas,
  });

  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${FILE_NAME}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
    },
  });
}
