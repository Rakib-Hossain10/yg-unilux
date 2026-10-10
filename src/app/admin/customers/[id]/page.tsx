// One customer (Phase 5 P8, plan Q1/Q5/Q10): profile, datasheet access
// (set / extend / none), password (reset link, temporary password shown
// once), sign-in (block / unblock, end sessions), invite (status and a new
// link), download history (20 a page), linked access requests and the audit
// trail. An unknown or malformed id, or the admin account, is a 404.
// requireAdmin() first (rule 3); no loading.tsx here, so not-found answers
// before streaming (gate A L-1).

import type { Metadata } from "next";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  KIND_LABELS,
  labelOf,
  SOURCE_LABELS,
} from "@/components/admin/access-requests/format";
import { accessRequestPath } from "@/components/admin/access-requests/paths";
import { StatusBadge } from "@/components/admin/access-requests/requests-table";
import { BackLink } from "@/components/admin/back-link";
import { AccessCard } from "@/components/admin/customers/access-card";
import { BlockCard } from "@/components/admin/customers/block-card";
import { InviteCard } from "@/components/admin/customers/invite-card";
import { auditLabel } from "@/components/admin/customers/labels";
import { PasswordCard } from "@/components/admin/customers/password-card";
import {
  customerPath,
  CUSTOMERS_PATH,
  readPage,
} from "@/components/admin/customers/paths";
import { ProfileCard } from "@/components/admin/customers/profile-card";
import { CustomerStatusBadges } from "@/components/admin/customers/status-badges";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getCustomer } from "@/lib/admin/customers";
import { requireAdmin } from "@/lib/permissions";
import { MAX_REJECT_REASON_LENGTH } from "@/models/access-request-constants";

import { formatDate, formatDateTime } from "@/lib/time-zone";

import { pageActor, readAsAdmin } from "../../admin-reads";
import { customerRowView } from "../customer-view";

// Static only (ADR 0036): never the customer's name.
export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({
  params,
  searchParams,
}: PageProps<"/admin/customers/[id]">) {
  const viewer = await requireAdmin();
  const [{ id }, query, actor] = await Promise.all([
    params,
    searchParams,
    pageActor(viewer),
  ]);
  // The service validates the id; a bad one is simply "not found".
  const page = await readAsAdmin(() =>
    getCustomer(actor, { userId: id, page: readPage(query.page) }),
  );
  if (!page) notFound();

  const { customer, downloads, requests, audit } = page;
  const view = customerRowView(customer);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink href={CUSTOMERS_PATH}>Customers</BackLink>
        <h1 className="min-w-0 text-2xl font-semibold break-words">
          {customer.name}
        </h1>
        <p className="text-sm break-all text-muted-foreground">
          {customer.email}
          {customer.company ? ` · ${customer.company}` : ""} · customer since{" "}
          <time dateTime={view.createdAt}>
            {formatDate(customer.createdAt)}
          </time>
        </p>
        <CustomerStatusBadges
          access={view.access}
          blocked={view.blocked}
          invite={view.invite}
          mustChangePassword={view.mustChangePassword}
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <AccessCard
          userId={customer.id}
          access={view.access}
          accessExpiresAt={view.accessExpiresAt}
          blocked={view.blocked}
        />
        <div className="flex flex-col gap-4">
          <InviteCard
            userId={customer.id}
            invite={view.invite}
            mustChangePassword={view.mustChangePassword}
            blocked={view.blocked}
          />
          <PasswordCard
            userId={customer.id}
            email={customer.email}
            blocked={view.blocked}
          />
          <BlockCard
            userId={customer.id}
            blocked={view.blocked}
            banReason={customer.banReason}
            reasonMaxLength={MAX_REJECT_REASON_LENGTH}
          />
        </div>
        <ProfileCard
          customer={{
            id: customer.id,
            name: customer.name,
            email: customer.email,
            company: customer.company,
            country: customer.country,
          }}
        />
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Access requests</h2>
            </CardTitle>
            <CardDescription>
              Requests from this email or linked to this account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {requests.length === 0 ? (
              <p className="text-sm text-muted-foreground">None.</p>
            ) : (
              <ul className="flex flex-col gap-3 text-sm">
                {requests.map((request) => (
                  <li
                    key={request.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1"
                  >
                    <Link
                      href={accessRequestPath(request.id)}
                      className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {labelOf(KIND_LABELS, request.kind)}
                    </Link>
                    <span className="text-muted-foreground">
                      {labelOf(SOURCE_LABELS, request.source)} ·{" "}
                      <time dateTime={request.createdAt.toISOString()}>
                        {formatDate(request.createdAt)}
                      </time>
                    </span>
                    <StatusBadge status={request.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <section
        aria-labelledby="downloads-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="downloads-heading" className="text-lg font-semibold">
          Download history{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({downloads.total})
          </span>
        </h2>
        {downloads.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No datasheet downloads yet.
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table aria-label="Download history">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Product</TableHead>
                  <TableHead className="hidden sm:table-cell">File</TableHead>
                  <TableHead className="pr-4">Downloaded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {downloads.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="max-w-48 pl-4 sm:max-w-72">
                      {row.product === null ? (
                        <span className="text-muted-foreground">
                          Deleted product
                        </span>
                      ) : row.product.listed ? (
                        <a
                          href={`/product/${row.product.slug}`}
                          target="_blank"
                          rel="noopener"
                          title={row.product.name}
                          className="block truncate underline-offset-4 hover:underline focus-visible:underline"
                        >
                          {row.product.name}
                        </a>
                      ) : (
                        <span
                          title={row.product.name}
                          className="block truncate"
                        >
                          {row.product.name}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden max-w-56 sm:table-cell">
                      <span
                        title={row.fileName ?? undefined}
                        className="block truncate"
                      >
                        {row.fileName ?? "Deleted file"}
                      </span>
                    </TableCell>
                    <TableCell className="pr-4 whitespace-nowrap text-muted-foreground">
                      <time dateTime={row.downloadedAt.toISOString()}>
                        {formatDateTime(row.downloadedAt)}
                      </time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {downloads.pageCount > 1 ? (
          <nav
            aria-label="Download history pages"
            className="flex flex-wrap items-center justify-between gap-3"
          >
            <p className="text-sm text-muted-foreground">
              Page {downloads.page} of {downloads.pageCount}
            </p>
            <div className="flex gap-2">
              <PagerLink
                href={
                  downloads.page > 1
                    ? customerPath(customer.id, downloads.page - 1)
                    : null
                }
              >
                <ChevronLeft data-icon="inline-start" aria-hidden="true" />
                Previous
              </PagerLink>
              <PagerLink
                href={
                  downloads.page < downloads.pageCount
                    ? customerPath(customer.id, downloads.page + 1)
                    : null
                }
              >
                Next
                <ChevronRight data-icon="inline-end" aria-hidden="true" />
              </PagerLink>
            </div>
          </nav>
        ) : null}
      </section>

      <section aria-labelledby="audit-heading" className="flex flex-col gap-3">
        <h2 id="audit-heading" className="text-lg font-semibold">
          Audit trail
        </h2>
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries yet.</p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm">
            {audit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap gap-x-3">
                <time
                  dateTime={entry.createdAt.toISOString()}
                  className="text-muted-foreground tabular-nums"
                >
                  {formatDateTime(entry.createdAt)}
                </time>
                <span>{auditLabel(entry.action)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

/* A pager button: a link, or disabled at either end. */
function PagerLink({
  href,
  children,
}: {
  href: string | null;
  children: ReactNode;
}) {
  return href === null ? (
    <Button variant="outline" size="sm" disabled>
      {children}
    </Button>
  ) : (
    <Button asChild variant="outline" size="sm">
      <Link href={href}>{children}</Link>
    </Button>
  );
}
