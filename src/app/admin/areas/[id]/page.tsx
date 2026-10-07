// Edit page for one area: the name/slug form and the black-and-white image
// uploader (saved on its own). An unknown or malformed id shows the segment's
// not-found page. requireAdmin() first (rule 3).

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AreaForm } from "@/components/admin/area-form";
import { AreaImageUploader } from "@/components/admin/area-image-uploader";
import { AREAS_PATH } from "@/components/admin/area-paths";
import { BackLink } from "@/components/admin/back-link";
import { getAreaForEdit } from "@/lib/admin/areas";
import { requireAdmin } from "@/lib/permissions";

import { adminCloudName } from "../../cloudinary-cloud-name";

// Static only (ADR 0036): never the area's name.
export const metadata: Metadata = { title: "Edit area" };

export default async function EditAreaPage({
  params,
}: PageProps<"/admin/areas/[id]">) {
  await requireAdmin();
  const { id } = await params;
  // The service validates the id; a bad one is simply "not found".
  const area = await getAreaForEdit(id);
  if (!area) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={AREAS_PATH}>Areas</BackLink>
        <h1 className="text-2xl font-semibold">Edit {area.name}</h1>
      </div>
      <AreaForm area={area} />
      <AreaImageUploader
        areaId={area.id}
        bwImage={area.bwImage}
        cloudName={adminCloudName()}
      />
    </div>
  );
}
