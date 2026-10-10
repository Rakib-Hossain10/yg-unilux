// One access request (Phase 5 P7): the requester's details, any existing
// account with this email, and Approve / Reject (pending) or Delete
// (handled). An unknown or malformed id is a 404. requireAdmin() first
// (rule 3); no loading.tsx here, so not-found answers before streaming.

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  formatAccessEnd,
  formatDayTime,
  KIND_LABELS,
  labelOf,
  SOURCE_LABELS,
} from "@/components/admin/access-requests/format";
import { accessRequestsListPath } from "@/components/admin/access-requests/paths";
import { RequestActions } from "@/components/admin/access-requests/request-actions";
import { StatusBadge } from "@/components/admin/access-requests/requests-table";
import { BackLink } from "@/components/admin/back-link";
import { NOTICE_PARAM, readNotice } from "@/components/admin/save-notice";
import { SaveNoticeAlert } from "@/components/admin/save-notice-alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAccessRequest } from "@/lib/admin/access-requests";
import type { InviteStatus } from "@/lib/invite";
import { requireAdmin } from "@/lib/permissions";

import { pageActor, readAsAdmin } from "../../admin-reads";

// Static only (ADR 0036): never the requester's name.
export const metadata: Metadata = { title: "Access request" };

const NOTICES = {
  created: "Request added. Approve or reject it below.",
  updated: "Request saved.",
  unchanged: "No changes to save.",
  deleted: "Request deleted.",
} as const;

const INVITE_LABELS = {
  none: "No invite link on record",
  accepted: "Password set",
} as const;

function inviteText(invite: InviteStatus): string {
  switch (invite.state) {
    case "pending":
      return `Invite link valid until ${formatDayTime(invite.until)}`;
    case "expired":
      return "Invite link expired, password never set";
    default:
      return INVITE_LABELS[invite.state];
  }
}

export default async function AccessRequestPage({
  params,
  searchParams,
}: PageProps<"/admin/access-requests/[id]">) {
  const viewer = await requireAdmin();
  const [{ id }, query, actor] = await Promise.all([
    params,
    searchParams,
    pageActor(viewer),
  ]);
  // The service validates the id; a bad one is simply "not found".
  const request = await readAsAdmin(() =>
    getAccessRequest(actor, { requestId: id }),
  );
  if (!request) notFound();

  const account = request.existingAccount;
  const handled = request.status !== "pending";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackLink
          href={accessRequestsListPath({
            tab: handled ? "handled" : "pending",
          })}
        >
          Access requests
        </BackLink>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 text-2xl font-semibold break-words">
            {request.name}
          </h1>
          <StatusBadge status={request.status} />
        </div>
        <p className="text-sm text-muted-foreground">
          {labelOf(KIND_LABELS, request.kind)} ·{" "}
          {labelOf(SOURCE_LABELS, request.source)} · received{" "}
          <time dateTime={request.createdAt.toISOString()}>
            {formatDayTime(request.createdAt)}
          </time>
        </p>
      </div>

      <SaveNoticeAlert
        notice={readNotice(query[NOTICE_PARAM])}
        messages={NOTICES}
      />

      <RequestActions
        status={request.status}
        request={{
          id: request.id,
          name: request.name,
          email: request.email,
          company: request.company,
          country: request.country,
          source: request.source,
          existing: account
            ? {
                userId: account.userId,
                isCustomer: account.isCustomer,
                blocked: account.blocked,
                accessExpiresAt: account.accessExpiresAt?.toISOString() ?? null,
                invite:
                  account.invite.state === "pending"
                    ? {
                        state: "pending",
                        until: account.invite.until.toISOString(),
                      }
                    : { state: account.invite.state },
              }
            : null,
        }}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Request</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-3 text-sm">
              <Row label="Email">
                <span className="break-all">{request.email}</span>
              </Row>
              <Row label="Company">{request.company ?? "—"}</Row>
              <Row label="Country">{request.country ?? "—"}</Row>
              <Row label="Phone">{request.phone ?? "—"}</Row>
              <Row label="Product">
                {request.product ? (
                  <>
                    {request.product.status === "published" ? (
                      <a
                        href={`/product/${request.product.slug}`}
                        className="underline underline-offset-4"
                        target="_blank"
                        rel="noopener"
                      >
                        {request.product.name}
                      </a>
                    ) : (
                      request.product.name
                    )}
                  </>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Message">
                {request.message ? (
                  <span className="break-words whitespace-pre-wrap">
                    {request.message}
                  </span>
                ) : (
                  "—"
                )}
              </Row>
              {request.consentAt ? (
                <Row label="Privacy consent">
                  {formatDayTime(request.consentAt)}
                </Row>
              ) : null}
              {request.handledAt ? (
                <Row
                  label={
                    request.status === "rejected" ? "Rejected" : "Approved"
                  }
                >
                  {formatDayTime(request.handledAt)}
                </Row>
              ) : null}
              {request.rejectReason ? (
                <Row label="Reject reason (internal)">
                  <span className="break-words whitespace-pre-wrap">
                    {request.rejectReason}
                  </span>
                </Row>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Account with this email</h2>
            </CardTitle>
            <CardDescription>
              {account === null
                ? "No account uses this email yet. Approving creates a customer account."
                : account.isCustomer
                  ? "Already a customer. Approving extends their access; no second account is made."
                  : "This email belongs to an account that is not a customer. Reject the request."}
            </CardDescription>
          </CardHeader>
          {account?.isCustomer ? (
            <CardContent>
              <dl className="flex flex-col gap-3 text-sm">
                <Row label="Access">
                  {formatAccessEnd(account.accessExpiresAt)}
                </Row>
                <Row label="Status">
                  {account.blocked ? (
                    <Badge variant="destructive">Blocked</Badge>
                  ) : (
                    "Active"
                  )}
                </Row>
                <Row label="Invite">{inviteText(account.invite)}</Row>
              </dl>
            </CardContent>
          ) : null}
        </Card>
      </div>
    </div>
  );
}

/* One label/value pair of a <dl>. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
