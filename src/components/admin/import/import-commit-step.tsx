"use client";

// Step 3 of the import (T9): batch progress ("n / N"), a failed batch with its
// way forward (try again, preview again or start over), then the result per
// product with a link to its edit page.

import { CircleAlert, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CommittedProduct, CommittedStatus } from "@/lib/import";

import { NATIVE_SELECT_CLASS } from "../native-select";
import { PRODUCTS_PATH, productEditPath } from "../product-paths";
import { ClientPager } from "./client-pager";
import {
  COMMITTED_STATUS_BADGE,
  COMMITTED_STATUS_LABELS,
  plural,
  rowsText,
} from "./import-labels";
import { pageOf } from "./import-view";
import type { ImportCommitState } from "./use-import-commit";

const STATUSES: readonly CommittedStatus[] = [
  "created",
  "updated",
  "unchanged",
  "blocked",
  "failed",
];

export function countByStatus(
  results: readonly CommittedProduct[],
): Record<CommittedStatus, number> {
  const counts: Record<CommittedStatus, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    blocked: 0,
    failed: 0,
  };
  for (const product of results) counts[product.status]++;
  return counts;
}

/** The per-product results, filterable by status, 50 per page. */
export function CommitResults({
  results,
}: {
  results: readonly CommittedProduct[];
}) {
  const counts = useMemo(() => countByStatus(results), [results]);
  const [status, setStatus] = useState<CommittedStatus | "all">(
    counts.failed > 0 ? "failed" : "all",
  );
  const [page, setPage] = useState(1);
  const filtered = useMemo(
    () =>
      status === "all" ? results : results.filter((r) => r.status === status),
    [results, status],
  );
  const view = pageOf(filtered, page);

  return (
    <div className="flex flex-col gap-4">
      <Field className="w-full sm:w-56">
        <FieldLabel htmlFor="import-result-status">Show</FieldLabel>
        <select
          id="import-result-status"
          className={NATIVE_SELECT_CLASS}
          value={status}
          onChange={(event) => {
            setStatus(event.currentTarget.value as CommittedStatus | "all");
            setPage(1);
          }}
        >
          <option value="all">All ({results.length})</option>
          {STATUSES.filter((s) => counts[s] > 0).map((s) => (
            <option key={s} value={s}>
              {COMMITTED_STATUS_LABELS[s]} ({counts[s]})
            </option>
          ))}
        </select>
      </Field>

      {view.rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No products</EmptyTitle>
            <EmptyDescription>Choose another status.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Result</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Sheet rows</TableHead>
                <TableHead>
                  <span className="sr-only">Link</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rows.map((product) => (
                <TableRow key={product.index} data-status={product.status}>
                  <TableCell>
                    <Badge variant={COMMITTED_STATUS_BADGE[product.status]}>
                      {COMMITTED_STATUS_LABELS[product.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-96 whitespace-normal">
                    <div className="font-medium">{product.name || "—"}</div>
                    {product.slug ? (
                      <div className="text-muted-foreground">
                        /product/{product.slug}
                      </div>
                    ) : null}
                    {product.status === "failed" && product.error ? (
                      <div className="text-destructive">{product.error}</div>
                    ) : null}
                    {product.status === "blocked" ? (
                      <div className="text-muted-foreground">
                        Not saved: fix its warnings in the sheet.
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    <div>{rowsText(product.rows)}</div>
                    <div className="text-muted-foreground">{product.sheet}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    {product.id ? (
                      <Button asChild variant="link" size="sm">
                        <Link href={productEditPath(product.id)}>
                          Edit<span className="sr-only"> {product.name}</span>
                        </Link>
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ClientPager
        label="Result pages"
        page={view.page}
        pageCount={view.pageCount}
        onPage={setPage}
      />
    </div>
  );
}

export function ImportCommitStep({
  commit,
  onPreviewAgain,
  onStartOver,
}: {
  commit: ImportCommitState;
  onPreviewAgain: () => void;
  onStartOver: () => void;
}) {
  const { phase, total, done, failure, results } = commit;
  const counts = useMemo(() => countByStatus(results), [results]);
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);

  return (
    <div className="flex flex-col gap-6" aria-busy={phase === "running"}>
      <div className="flex max-w-2xl flex-col gap-2">
        <Progress value={percent} aria-label="Batches saved" />
        <p role="status" aria-live="polite" className="text-sm tabular-nums">
          {phase === "running"
            ? `Saving batch ${Math.min(done + 1, total)} / ${total}… Keep this page open.`
            : phase === "done"
              ? `All ${plural(total, "batch", "batches")} saved.`
              : `${done} / ${total} batches saved.`}
        </p>
      </div>

      {phase === "failed" && failure !== null ? (
        <Alert variant="destructive" role="alert" className="max-w-3xl">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {failure.saved === true
              ? "Batch saved, with a problem"
              : failure.saved === "unknown"
                ? "The batch could not be confirmed"
                : "The batch was not saved"}
          </AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {failure.messages.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
            <p className="mt-2">
              Batches already saved stay saved. Products saved before are
              skipped when you continue.
            </p>
            <div className="mt-3 flex flex-wrap gap-3">
              {failure.next === "retry" ? (
                <Button
                  type="button"
                  onClick={commit.retry}
                  disabled={commit.pending}
                >
                  Try this batch again
                </Button>
              ) : null}
              {failure.next === "preview" || failure.next === "confirm" ? (
                <Button type="button" onClick={onPreviewAgain}>
                  Preview the file again
                </Button>
              ) : null}
              <Button type="button" variant="outline" onClick={onStartOver}>
                Start over
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {phase === "done" ? (
        <Alert className="max-w-3xl">
          <CircleCheck aria-hidden="true" />
          <AlertTitle>Import finished</AlertTitle>
          <AlertDescription>
            <p>
              {plural(counts.created, "product")} created (as drafts),{" "}
              {counts.updated} updated, {counts.unchanged} unchanged,{" "}
              {counts.blocked} blocked
              {counts.failed > 0 ? `, ${counts.failed} failed` : ""}.
            </p>
            {counts.failed > 0 ? (
              <p>
                Upload the same file again to retry the failed products: the
                saved ones show as unchanged.
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-3">
              <Button asChild>
                <Link href={PRODUCTS_PATH}>Go to products</Link>
              </Button>
              <Button type="button" variant="outline" onClick={onStartOver}>
                Import another file
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Only once every batch was sent: before that, unsent products have
          no result yet. */}
      {phase === "done" ? <CommitResults results={results} /> : null}
    </div>
  );
}
