// Admin customers list (Phase 5 P8, plan Q10): search name/email/company, one
// status filter (incl. "Invite pending" / "Invite expired"), sort, 50 rows a
// page, and "New customer". Filters live in the URL. requireAdmin() first
// (rule 3; the layout doesn't re-run on client navigation), then the P3
// service with the admin as actor (ADR 0073).

import type { Metadata } from "next";
import { Plus, SearchX, Users } from "lucide-react";
import Link from "next/link";

import { CustomerFilters } from "@/components/admin/customers/customer-filters";
import {
  CustomersPager,
  CustomersTable,
} from "@/components/admin/customers/customers-table";
import { STATUS_FILTER_LABELS } from "@/components/admin/customers/labels";
import {
  CUSTOMERS_PATH,
  NEW_CUSTOMER_PATH,
  readPage,
  readSearch,
  readSort,
  readStatus,
} from "@/components/admin/customers/paths";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { listCustomers } from "@/lib/admin/customers";
import { requireAdmin } from "@/lib/permissions";

import { pageActor, readAsAdmin } from "../../admin-reads";
import { customerRowView } from "../customer-view";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Customers" };

export default async function AdminCustomersPage({
  searchParams,
}: PageProps<"/admin/customers">) {
  const viewer = await requireAdmin();
  const [query, actor] = await Promise.all([searchParams, pageActor(viewer)]);
  const q = readSearch(query.q);
  const status = readStatus(query.status);
  const sort = readSort(query.sort);
  const result = await readAsAdmin(() =>
    listCustomers(actor, {
      q,
      status: status ?? "",
      sort,
      page: readPage(query.page),
    }),
  );

  const filtered = q !== "" || status !== null;
  const listQuery = { q, status, sort };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Customers</h1>
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {filtered
              ? `${result.total} matching ${result.total === 1 ? "customer" : "customers"}${status ? ` (${STATUS_FILTER_LABELS[status]})` : ""}.`
              : `People who can sign in and download datasheets. ${result.total} in total.`}
          </p>
        </div>
        <Button asChild>
          <Link href={NEW_CUSTOMER_PATH}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            New customer
          </Link>
        </Button>
      </div>

      {result.total === 0 && !filtered ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Users aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No customers yet</EmptyTitle>
            <EmptyDescription>
              Create a customer here, or approve an access request. Each new
              customer gets an invite link to set a password.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link href={NEW_CUSTOMER_PATH}>
                <Plus data-icon="inline-start" aria-hidden="true" />
                New customer
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <CustomerFilters
            q={q}
            status={status}
            sort={sort}
            filtered={filtered}
          />

          {result.rows.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchX aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No customers match</EmptyTitle>
                <EmptyDescription>
                  Try another search or another status.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button asChild variant="outline">
                  <Link href={CUSTOMERS_PATH}>Clear filters</Link>
                </Button>
              </EmptyContent>
            </Empty>
          ) : (
            <CustomersTable rows={result.rows.map(customerRowView)} />
          )}

          <CustomersPager
            query={listQuery}
            page={result.page}
            pageCount={result.pageCount}
          />
        </>
      )}
    </div>
  );
}
