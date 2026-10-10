// Admin access-request queue (Phase 5 P7): "Pending" and "Handled" tabs, 50
// rows a page, newest first, each row opening the request; plus the manual
// WhatsApp entry. requireAdmin() first (rule 3; the layout doesn't re-run on
// client navigation), then the P3 service with the admin as actor (ADR 0073).

import type { Metadata } from "next";
import { Inbox } from "lucide-react";
import Link from "next/link";

import { ManualRequestDialog } from "@/components/admin/access-requests/manual-request-dialog";
import {
  accessRequestsListPath,
  readPage,
  readTab,
  REQUEST_TABS,
  type RequestTab,
} from "@/components/admin/access-requests/paths";
import {
  RequestsPager,
  RequestsTable,
} from "@/components/admin/access-requests/requests-table";
import { NOTICE_PARAM, readNotice } from "@/components/admin/save-notice";
import { SaveNoticeAlert } from "@/components/admin/save-notice-alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { listAccessRequests } from "@/lib/admin/access-requests";
import { requireAdmin } from "@/lib/permissions";

import { pageActor, readAsAdmin } from "../../admin-reads";

// Static only (ADR 0036): a title never carries data.
export const metadata: Metadata = { title: "Access requests" };

const NOTICES = {
  created: "Request added.",
  updated: "Request saved.",
  unchanged: "No changes to save.",
  deleted: "Request deleted.",
} as const;

const TAB_LABELS: Record<RequestTab, string> = {
  pending: "Pending",
  handled: "Handled",
};

export default async function AdminAccessRequestsPage({
  searchParams,
}: PageProps<"/admin/access-requests">) {
  const viewer = await requireAdmin();
  const [query, actor] = await Promise.all([searchParams, pageActor(viewer)]);
  const tab = readTab(query.tab);
  const result = await readAsAdmin(() =>
    listAccessRequests(actor, { tab, page: readPage(query.page) }),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Access requests</h1>
          <p className="text-sm text-muted-foreground">
            People asking to download datasheets. Approving creates a customer
            account (or extends an existing one) and sends an invite link.
          </p>
        </div>
        <ManualRequestDialog />
      </div>

      <SaveNoticeAlert
        notice={readNotice(query[NOTICE_PARAM])}
        messages={NOTICES}
      />

      <nav aria-label="Request lists" className="flex gap-2">
        {REQUEST_TABS.map((item) => (
          <Button
            key={item}
            asChild
            variant={item === tab ? "secondary" : "ghost"}
            size="sm"
          >
            <Link
              href={accessRequestsListPath({ tab: item })}
              aria-current={item === tab ? "page" : undefined}
            >
              {TAB_LABELS[item]}
              {item === tab ? ` (${result.total})` : null}
            </Link>
          </Button>
        ))}
      </nav>

      {result.rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {tab === "pending"
                ? "No pending requests"
                : "No handled requests"}
            </EmptyTitle>
            <EmptyDescription>
              {tab === "pending"
                ? "New requests from the website form appear here. Add one you received on WhatsApp with the button above."
                : "Approved and rejected requests appear here."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <RequestsTable
            tab={tab}
            rows={result.rows.map((row) => ({
              id: row.id,
              name: row.name,
              email: row.email,
              company: row.company,
              country: row.country,
              kind: row.kind,
              source: row.source,
              status: row.status,
              createdAt: row.createdAt.toISOString(),
              handledAt: row.handledAt?.toISOString() ?? null,
              existingCustomer: row.existingCustomer,
            }))}
          />
          <RequestsPager
            tab={tab}
            page={result.page}
            pageCount={result.pageCount}
          />
        </>
      )}
    </div>
  );
}
