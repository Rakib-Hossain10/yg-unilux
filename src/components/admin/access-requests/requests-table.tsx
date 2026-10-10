// The access-request table on /admin/access-requests (one page of up to 50
// rows: requester, company, country, kind, source, date, status) and its
// pager. Server-rendered: links only, no client JavaScript. On a phone the
// secondary columns are hidden; the request page shows everything.

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  formatDay,
  KIND_LABELS,
  labelOf,
  SOURCE_LABELS,
  STATUS_LABELS,
} from "./format";
import {
  accessRequestPath,
  accessRequestsListPath,
  type RequestTab,
} from "./paths";

/** One row as the table needs it. Dates are ISO strings. */
export interface RequestRowData {
  id: string;
  name: string;
  email: string;
  company: string | null;
  country: string | null;
  kind: string;
  source: string;
  status: string;
  createdAt: string;
  handledAt: string | null;
  existingCustomer: boolean;
}

export function StatusBadge({ status }: { status: string }) {
  const label = labelOf(STATUS_LABELS, status);
  if (status === "pending") return <Badge>{label}</Badge>;
  if (status === "rejected") return <Badge variant="outline">{label}</Badge>;
  return <Badge variant="secondary">{label}</Badge>;
}

export function RequestsTable({
  rows,
  tab,
}: {
  rows: RequestRowData[];
  tab: RequestTab;
}) {
  const handled = tab === "handled";
  return (
    <div className="rounded-lg border">
      <Table aria-label={handled ? "Handled requests" : "Pending requests"}>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Requester</TableHead>
            <TableHead className="hidden md:table-cell">Company</TableHead>
            <TableHead className="hidden lg:table-cell">Country</TableHead>
            <TableHead className="hidden sm:table-cell">Type</TableHead>
            <TableHead className="hidden lg:table-cell">Source</TableHead>
            <TableHead>{handled ? "Handled" : "Received"}</TableHead>
            <TableHead className="pr-4">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const date = handled
              ? (row.handledAt ?? row.createdAt)
              : row.createdAt;
            return (
              <TableRow key={row.id}>
                <TableCell className="max-w-56 pl-4 sm:max-w-72">
                  {/* Long values are cut with an ellipsis; `title` keeps
                      the full text available on hover. */}
                  <Link
                    href={accessRequestPath(row.id)}
                    title={row.name}
                    className="block truncate font-medium underline-offset-4 hover:underline focus-visible:underline"
                  >
                    {row.name}
                  </Link>
                  <span
                    title={row.email}
                    className="block truncate text-muted-foreground"
                  >
                    {row.email}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-48 md:table-cell">
                  <span
                    title={row.company ?? undefined}
                    className="block truncate"
                  >
                    {row.company ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="hidden max-w-40 lg:table-cell">
                  <span
                    title={row.country ?? undefined}
                    className="block truncate"
                  >
                    {row.country ?? "—"}
                  </span>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {labelOf(KIND_LABELS, row.kind)}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {labelOf(SOURCE_LABELS, row.source)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={date}>{formatDay(date)}</time>
                </TableCell>
                <TableCell className="pr-4">
                  <div className="flex flex-wrap gap-1">
                    <StatusBadge status={row.status} />
                    {row.existingCustomer ? (
                      <Badge variant="outline">Existing customer</Badge>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** "Page 2 of 3" with Previous/Next links that keep the tab. */
export function RequestsPager({
  tab,
  page,
  pageCount,
}: {
  tab: RequestTab;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav
      aria-label="Request pages"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-muted-foreground">
        Page {page} of {pageCount}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={accessRequestsListPath({ tab, page: page - 1 })}>
              <ChevronLeft data-icon="inline-start" aria-hidden="true" />
              Previous
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft data-icon="inline-start" aria-hidden="true" />
            Previous
          </Button>
        )}
        {page < pageCount ? (
          <Button asChild variant="outline" size="sm">
            <Link href={accessRequestsListPath({ tab, page: page + 1 })}>
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
  );
}
