// The customers table on /admin/customers (one page of up to 50 rows:
// customer, company, country, access, status, created) and its pager.
// Server-rendered; the only client code is the row's "New link…" dialog,
// offered while an invite is open. On a phone the secondary columns are
// hidden; the customer page shows everything.

import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { formatDate } from "@/lib/time-zone";

import {
  accessText,
  inviteOpen,
  type AccessStateView,
  type InviteStatusView,
} from "./labels";
import { NewInviteDialog } from "./new-invite-dialog";
import {
  customerPath,
  customersListPath,
  type CustomerListQuery,
} from "./paths";
import { CustomerStatusBadges } from "./status-badges";

/** One row as the table needs it. Dates are ISO strings. */
export interface CustomerRowData {
  id: string;
  name: string;
  email: string;
  company: string | null;
  country: string | null;
  createdAt: string;
  accessExpiresAt: string | null;
  access: AccessStateView;
  blocked: boolean;
  mustChangePassword: boolean;
  invite: InviteStatusView;
}

export function CustomersTable({ rows }: { rows: CustomerRowData[] }) {
  return (
    <div className="rounded-lg border">
      <Table aria-label="Customers">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Customer</TableHead>
            <TableHead className="hidden md:table-cell">Company</TableHead>
            <TableHead className="hidden xl:table-cell">Country</TableHead>
            <TableHead className="hidden sm:table-cell">Access</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden lg:table-cell">Created</TableHead>
            <TableHead className="pr-4">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="max-w-48 pl-4 sm:max-w-72">
                {/* Long values are cut with an ellipsis; `title` keeps
                    the full text available on hover. */}
                <Link
                  href={customerPath(row.id)}
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
              <TableCell className="hidden max-w-40 xl:table-cell">
                <span
                  title={row.country ?? undefined}
                  className="block truncate"
                >
                  {row.country ?? "—"}
                </span>
              </TableCell>
              <TableCell className="hidden whitespace-nowrap sm:table-cell">
                {accessText(row.access, row.accessExpiresAt)}
              </TableCell>
              <TableCell>
                <CustomerStatusBadges
                  access={row.access}
                  blocked={row.blocked}
                  invite={row.invite}
                  mustChangePassword={row.mustChangePassword}
                />
              </TableCell>
              <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                <time dateTime={row.createdAt}>
                  {formatDate(row.createdAt)}
                </time>
              </TableCell>
              <TableCell className="pr-4 text-right">
                {!row.blocked &&
                inviteOpen(row.invite, row.mustChangePassword) ? (
                  <NewInviteDialog
                    userId={row.id}
                    name={row.name}
                    email={row.email}
                  />
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** "Page 2 of 3" with Previous/Next links that keep the filters. */
export function CustomersPager({
  query,
  page,
  pageCount,
}: {
  query: Omit<CustomerListQuery, "page" | "notice">;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav
      aria-label="Customer pages"
      className="flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-sm text-muted-foreground">
        Page {page} of {pageCount}
      </p>
      <div className="flex gap-2">
        {page > 1 ? (
          <Button asChild variant="outline" size="sm">
            <Link href={customersListPath({ ...query, page: page - 1 })}>
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
            <Link href={customersListPath({ ...query, page: page + 1 })}>
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
