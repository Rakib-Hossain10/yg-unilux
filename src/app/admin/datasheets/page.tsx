// Admin datasheets list: the restricted Excel files with size, uploader, last
// update and how many products use each, plus upload, rename, replace and
// delete. requireAdmin() first (rule 3; the layout doesn't re-run on client
// navigation). The storage key and any URL are never read into the page.

import type { Metadata } from "next";
import {
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  Search,
} from "lucide-react";
import Link from "next/link";

import { DatasheetList } from "@/components/admin/datasheet-list";
import {
  datasheetsListPath,
  DATASHEETS_PATH,
  pageDatasheets,
} from "@/components/admin/datasheet-paths";
import { DatasheetUploader } from "@/components/admin/datasheet-uploader";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { listDatasheets } from "@/lib/admin/datasheets";
import { requireAdmin } from "@/lib/permissions";

import { uploaderLabels } from "./uploader-names";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Datasheets" };

const MAX_QUERY_LENGTH = 80;

/* One value of a search param: the first when repeated, "" when missing. */
function single(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

export default async function AdminDatasheetsPage({
  searchParams,
}: PageProps<"/admin/datasheets">) {
  await requireAdmin();
  const [datasheets, query] = await Promise.all([
    listDatasheets(),
    searchParams,
  ]);
  const q = single(query.q).trim().slice(0, MAX_QUERY_LENGTH);
  const requestedPage = Number.parseInt(single(query.page), 10);
  const view = pageDatasheets(datasheets, {
    q,
    page: Number.isFinite(requestedPage) ? requestedPage : 1,
  });
  const names = await uploaderLabels(view.rows.map((row) => row.uploadedBy));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Datasheets</h1>
        <p className="text-sm text-muted-foreground">
          Excel files customers download from product pages. Attach one to a
          product on its edit page.
          {datasheets.length > 0 ? ` ${datasheets.length} in total.` : null}
        </p>
      </div>

      <DatasheetUploader />

      {datasheets.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileSpreadsheet aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No datasheets yet</EmptyTitle>
            <EmptyDescription>
              Upload an Excel file above. Products show &quot;Datasheet coming
              soon&quot; until one is attached.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <form
            role="search"
            action={DATASHEETS_PATH}
            className="flex max-w-md items-center gap-2"
          >
            <label htmlFor="datasheet-search" className="sr-only">
              Search datasheets by file name
            </label>
            <Input
              id="datasheet-search"
              type="search"
              name="q"
              defaultValue={q}
              maxLength={MAX_QUERY_LENGTH}
              placeholder="Search by file name"
              autoComplete="off"
            />
            <Button type="submit" variant="outline">
              <Search data-icon="inline-start" aria-hidden="true" />
              Search
            </Button>
          </form>

          {view.rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No matching datasheets</EmptyTitle>
                <EmptyDescription>
                  Nothing matches &quot;{q}&quot;.{" "}
                  <Link href={DATASHEETS_PATH} className="underline">
                    Show all datasheets
                  </Link>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <DatasheetList
              rows={view.rows.map((row) => ({
                id: row.id,
                fileName: row.fileName,
                size: row.size,
                uploader: names.get(row.uploadedBy) ?? "Removed account",
                updatedAt: row.updatedAt.toISOString(),
                inUse: row.inUse,
              }))}
            />
          )}

          {view.pageCount > 1 ? (
            <nav
              aria-label="Datasheet pages"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <p className="text-sm text-muted-foreground">
                Page {view.page} of {view.pageCount}
              </p>
              <div className="flex gap-2">
                {view.page > 1 ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={datasheetsListPath({ q, page: view.page - 1 })}>
                      <ChevronLeft
                        data-icon="inline-start"
                        aria-hidden="true"
                      />
                      Previous
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    <ChevronLeft data-icon="inline-start" aria-hidden="true" />
                    Previous
                  </Button>
                )}
                {view.page < view.pageCount ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={datasheetsListPath({ q, page: view.page + 1 })}>
                      Next
                      <ChevronRight data-icon="inline-end" aria-hidden="true" />
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" disabled>
                    Next
                    <ChevronRight data-icon="inline-end" aria-hidden="true" />
                  </Button>
                )}
              </div>
            </nav>
          ) : null}
        </div>
      )}
    </div>
  );
}
