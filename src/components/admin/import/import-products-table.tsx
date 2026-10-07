"use client";

// The preview's product table (T9): one row per sheet product with its status,
// sheet rows, variants and new pictures; a row opens to show what changes
// (the first changes, then "+N more"), the variants that would be removed and
// the product's own warnings. Search and a status filter, 50 per page.

import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { PlanStatus } from "@/lib/import/types";

import { NATIVE_SELECT_CLASS } from "../native-select";
import { ClientPager } from "./client-pager";
import {
  PLAN_STATUS_BADGE,
  PLAN_STATUS_LABELS,
  plural,
  rowsText,
} from "./import-labels";
import {
  filterEntries,
  isRestrictedChange,
  pageOf,
  type EntryFilter,
  type PreviewEntryView,
} from "./import-view";
import { WarningItem } from "./warning-item";

const STATUSES: readonly PlanStatus[] = [
  "create",
  "update",
  "unchanged",
  "blocked",
];

const COLUMN_COUNT = 6;

/** The open row's details: changes, removals and warnings. */
export function EntryDetails({
  entry,
  restricted,
}: {
  entry: PreviewEntryView;
  restricted: ReadonlySet<string>;
}) {
  const hasChanges = entry.changes.length > 0;
  return (
    <div className="flex flex-col gap-4 py-2 text-sm">
      {entry.status === "create" ? (
        <p>
          A new draft product with {plural(entry.variantCount, "variant")}
          {entry.modelNos.length > 0 ? ` (${entry.modelNos.join(", ")})` : ""}.
        </p>
      ) : null}
      {entry.status === "unchanged" ? (
        <p>The saved product already matches the sheet.</p>
      ) : null}

      {hasChanges ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">Changes</h4>
          <ul className="flex flex-col gap-1">
            {entry.changes.map((change) => (
              <li key={change.field} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{change.label}</span>
                {isRestrictedChange(change, restricted) ? (
                  <Badge variant="secondary">Restricted</Badge>
                ) : null}
                <span className="text-muted-foreground">
                  {change.before ?? "not set"}
                </span>
                <span aria-label="becomes">→</span>
                <span>{change.after ?? "not set"}</span>
              </li>
            ))}
          </ul>
          {entry.moreChanges > 0 ? (
            <p className="text-muted-foreground">
              +{plural(entry.moreChanges, "more change")}
            </p>
          ) : null}
        </div>
      ) : null}

      {entry.variantsRemoved.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="font-medium">Variants not in the sheet</h4>
          <p>
            {entry.variantsRemoved.join(", ")}. They are removed only if you
            confirm it before saving.
          </p>
        </div>
      ) : null}

      {entry.warnings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="font-medium">Warnings</h4>
          <ul className="flex flex-col gap-3">
            {entry.warnings.map((warning, index) => (
              <li key={index}>
                <WarningItem warning={warning} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ImportProductsTable({
  entries,
  restrictedColumns,
}: {
  entries: readonly PreviewEntryView[];
  restrictedColumns: readonly string[];
}) {
  const [filter, setFilter] = useState<EntryFilter>({ status: "all", q: "" });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const restricted = useMemo(
    () => new Set(restrictedColumns),
    [restrictedColumns],
  );
  const filtered = useMemo(
    () => filterEntries(entries, filter),
    [entries, filter],
  );
  const view = pageOf(filtered, page);

  const update = (next: Partial<EntryFilter>) => {
    setFilter((current) => ({ ...current, ...next }));
    setPage(1);
  };
  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(index)) next.add(index);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-full sm:w-80">
          <FieldLabel htmlFor="import-product-search">Search</FieldLabel>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="import-product-search"
              type="search"
              className="pl-8"
              value={filter.q}
              maxLength={80}
              autoComplete="off"
              placeholder="Name, family, NO. or model no."
              onChange={(event) => update({ q: event.currentTarget.value })}
            />
          </div>
        </Field>
        <Field className="w-full sm:w-48">
          <FieldLabel htmlFor="import-product-status">Status</FieldLabel>
          <select
            id="import-product-status"
            className={NATIVE_SELECT_CLASS}
            value={filter.status}
            onChange={(event) =>
              update({
                status: event.currentTarget.value as EntryFilter["status"],
              })
            }
          >
            <option value="all">All</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {PLAN_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        {filtered.length === entries.length
          ? `${plural(entries.length, "product")} in the file.`
          : `${plural(filtered.length, "product")} of ${entries.length} match.`}
      </p>

      {view.rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No matching products</EmptyTitle>
            <EmptyDescription>
              Change the search or the status.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Sheet rows</TableHead>
                <TableHead className="text-right">Variants</TableHead>
                <TableHead className="text-right">New pictures</TableHead>
                <TableHead>
                  <span className="sr-only">Details</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.rows.map((entry) => {
                const isOpen = open.has(entry.index);
                const detailsId = `import-entry-${entry.index}`;
                const problems = entry.warnings.length;
                return (
                  <Fragment key={entry.index}>
                    <TableRow data-status={entry.status}>
                      <TableCell>
                        <Badge variant={PLAN_STATUS_BADGE[entry.status]}>
                          {PLAN_STATUS_LABELS[entry.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-72 whitespace-normal">
                        <div className="font-medium">{entry.name || "—"}</div>
                        <div className="text-muted-foreground">
                          {entry.productNo !== null
                            ? `NO. ${entry.productNo}`
                            : "No NO."}
                          {entry.family ? ` · ${entry.family}` : ""}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        <div>{rowsText(entry.rows)}</div>
                        <div className="text-muted-foreground">
                          {entry.sheet}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {entry.variantCount}
                        {entry.variantsRemoved.length > 0 ? (
                          <div className="text-destructive">
                            −{entry.variantsRemoved.length}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {entry.newImageCount}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-expanded={isOpen}
                          aria-controls={isOpen ? detailsId : undefined}
                          onClick={() => toggle(entry.index)}
                        >
                          {isOpen ? (
                            <ChevronDown
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                          ) : (
                            <ChevronRight
                              data-icon="inline-start"
                              aria-hidden="true"
                            />
                          )}
                          {problems > 0
                            ? plural(problems, "warning")
                            : "Details"}
                          <span className="sr-only"> of {entry.name}</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                    {isOpen ? (
                      <TableRow id={detailsId}>
                        <TableCell
                          colSpan={COLUMN_COUNT}
                          className="whitespace-normal"
                        >
                          <EntryDetails entry={entry} restricted={restricted} />
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ClientPager
        label="Product pages"
        page={view.page}
        pageCount={view.pageCount}
        onPage={setPage}
      />
    </div>
  );
}
