"use client";

// Every finding of the previewed file in one list, filterable by severity and
// by code, 50 per page (T9). Shown to the admin only; the text never leaves
// this screen.

import { useMemo, useState } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import type { WarningCode, WarningSeverity } from "@/lib/import/types";

import { NATIVE_SELECT_CLASS } from "../native-select";
import { ClientPager } from "./client-pager";
import { plural, SEVERITY_LABELS, WARNING_LABELS } from "./import-labels";
import {
  filterWarnings,
  pageOf,
  severityCounts,
  warningCodeCounts,
  type WarningFilter,
  type WarningRow,
} from "./import-view";
import { WarningItem } from "./warning-item";

const SEVERITIES: readonly WarningSeverity[] = ["fatal", "error", "warning"];

export function ImportWarnings({ rows }: { rows: readonly WarningRow[] }) {
  const [filter, setFilter] = useState<WarningFilter>({
    severity: "all",
    code: "all",
  });
  const [page, setPage] = useState(1);
  const codes = useMemo(() => warningCodeCounts(rows), [rows]);
  const severities = useMemo(() => severityCounts(rows), [rows]);
  const filtered = useMemo(() => filterWarnings(rows, filter), [rows, filter]);
  const view = pageOf(filtered, page);

  if (rows.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>No warnings</EmptyTitle>
          <EmptyDescription>
            The file has no problems the import could find.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const update = (next: Partial<WarningFilter>) => {
    setFilter((current) => ({ ...current, ...next }));
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-4">
        <Field className="w-full sm:w-56">
          <FieldLabel htmlFor="import-warning-severity">Severity</FieldLabel>
          <select
            id="import-warning-severity"
            className={NATIVE_SELECT_CLASS}
            value={filter.severity}
            onChange={(event) =>
              update({
                severity: event.currentTarget
                  .value as WarningFilter["severity"],
              })
            }
          >
            <option value="all">All ({rows.length})</option>
            {SEVERITIES.filter((s) => severities[s] > 0).map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABELS[s]} ({severities[s]})
              </option>
            ))}
          </select>
        </Field>
        <Field className="w-full sm:w-80">
          <FieldLabel htmlFor="import-warning-code">Kind</FieldLabel>
          <select
            id="import-warning-code"
            className={NATIVE_SELECT_CLASS}
            value={filter.code}
            onChange={(event) =>
              update({ code: event.currentTarget.value as WarningCode | "all" })
            }
          >
            <option value="all">All kinds</option>
            {codes.map(({ code, count }) => (
              <option key={code} value={code}>
                {WARNING_LABELS[code].title} ({count})
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
        {filtered.length === rows.length
          ? `Showing all ${plural(rows.length, "finding")}.`
          : `Showing ${plural(filtered.length, "finding")} of ${rows.length}.`}
      </p>

      {view.rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No matching findings</EmptyTitle>
            <EmptyDescription>
              Choose another severity or kind.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {view.rows.map((row, index) => (
            <li key={`${view.page}-${index}`} className="p-3">
              <WarningItem warning={row.warning} product={row.product} />
            </li>
          ))}
        </ul>
      )}

      <ClientPager
        label="Warning pages"
        page={view.page}
        pageCount={view.pageCount}
        onPage={setPage}
      />
    </div>
  );
}
