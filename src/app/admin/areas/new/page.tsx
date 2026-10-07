// New area page: the create form. requireAdmin() first (rule 3).

import type { Metadata } from "next";

import { AreaForm } from "@/components/admin/area-form";
import { AREAS_PATH } from "@/components/admin/area-paths";
import { BackLink } from "@/components/admin/back-link";
import { requireAdmin } from "@/lib/permissions";

export const metadata: Metadata = { title: "New area" };

export default async function NewAreaPage() {
  await requireAdmin();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={AREAS_PATH}>Areas</BackLink>
        <h1 className="text-2xl font-semibold">New area</h1>
      </div>
      <AreaForm />
    </div>
  );
}
