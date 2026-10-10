// Admin areas list: the application areas in display order with move,
// edit and delete, the "saved" notice after a redirect, and an empty state.
// requireAdmin() first (rule 3; the layout doesn't re-run on client nav).

import type { Metadata } from "next";
import { LayoutGrid, Plus } from "lucide-react";
import Link from "next/link";

import { AreaList } from "@/components/admin/area-list";
import { NEW_AREA_PATH } from "@/components/admin/area-paths";
import { NOTICE_PARAM, readNotice } from "@/components/admin/save-notice";
import { SaveNoticeAlert } from "@/components/admin/save-notice-alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { listAreas } from "@/lib/admin/areas";
import { requireAdmin } from "@/lib/permissions";

import { pageActor, readAsAdmin } from "../admin-reads";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Areas" };

const NOTICES = {
  created: "Area created.",
  updated: "Area saved.",
  unchanged: "No changes to save.",
  deleted: "Area deleted.",
} as const;

export default async function AdminAreasPage({
  searchParams,
}: PageProps<"/admin/areas">) {
  const viewer = await requireAdmin();
  const actor = await pageActor(viewer);
  const [areas, query] = await Promise.all([
    readAsAdmin(() => listAreas(actor)),
    searchParams,
  ]);
  const notice = readNotice(query[NOTICE_PARAM]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Areas</h1>
          <p className="text-sm text-muted-foreground">
            Where the lights are used, shown in this order on the site.
            {areas.length > 0 ? ` ${areas.length} in total.` : null}
          </p>
        </div>
        {areas.length > 0 ? (
          <Button asChild>
            <Link href={NEW_AREA_PATH}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              New area
            </Link>
          </Button>
        ) : null}
      </div>

      <SaveNoticeAlert notice={notice} messages={NOTICES} />

      {areas.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutGrid aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No areas yet</EmptyTitle>
            <EmptyDescription>
              Add the places the lights are used, such as Residential or Retail.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link href={NEW_AREA_PATH}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                New area
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <AreaList
          items={areas.map(({ id, name, slug }) => ({ id, name, slug }))}
        />
      )}
    </div>
  );
}
