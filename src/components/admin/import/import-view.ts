// What the import page's client receives (T9, ADR 0058), and the pure helpers
// the steps share. `toPreviewView` runs in the Server Action: it keeps only
// what the screen shows (no merged spec values, no picture refs), which also
// keeps the response small for a 5,000-product file. Client-safe: type-only
// imports from the server modules.

import type { ActionFailure } from "@/components/admin/action-result";
import type { CommitBatchResult, ImportPreview } from "@/lib/import";
import { IMPORT_BATCH_SIZE } from "@/lib/constants";
import type {
  ImportPlanSummary,
  ImportWarning,
  PlanChange,
  PlanStatus,
  WarningCode,
  WarningSeverity,
} from "@/lib/import/types";

/** The presigned PUT of the import file. Use once; never show or log it. */
export interface ImportUploadTicket {
  uploadUrl: string;
  /** Sent with the PUT exactly as given: the signature covers them. */
  headers: { "Content-Type": string };
  /** `imports/<uuid>.xlsx`, passed back to preview, commit and finish. */
  key: string;
  expiresIn: number;
}

export interface PreviewEntryView {
  /** Index in the plan (the commit's batch numbering uses it). */
  index: number;
  status: PlanStatus;
  sheet: string;
  rows: number[];
  productNo: number | null;
  family: string | null;
  name: string;
  /** The saved product's id (update / unchanged), else null. */
  existingId: string | null;
  slug: string | null;
  modelNos: string[];
  variantCount: number;
  /** Sheet pictures the product does not hold yet. */
  newImageCount: number;
  variantsRemoved: string[];
  changes: PlanChange[];
  moreChanges: number;
  warnings: ImportWarning[];
  /** The preview's entry hash, sent back with every commit batch. */
  hash: string;
}

export type ImportPreviewView =
  | {
      kind: "plan";
      etag: string | null;
      planHash: string;
      entries: PreviewEntryView[];
      /** Findings about the file, a sheet, or rows of no product. */
      fileWarnings: ImportWarning[];
      summary: ImportPlanSummary;
    }
  | { kind: "refused"; warnings: ImportWarning[] };

export type PlanView = Extract<ImportPreviewView, { kind: "plan" }>;

/** Keeps what the preview screen shows. Runs on the server. */
export function toPreviewView(preview: ImportPreview): ImportPreviewView {
  if (preview.kind === "refused") {
    return { kind: "refused", warnings: preview.warnings };
  }
  const { plan } = preview;
  return {
    kind: "plan",
    etag: preview.etag,
    planHash: plan.planHash,
    fileWarnings: plan.warnings,
    summary: plan.summary,
    entries: plan.entries.map((entry, index) => ({
      index,
      status: entry.status,
      sheet: entry.sheet,
      rows: entry.rows,
      productNo: entry.productNo,
      family: entry.family,
      name: entry.name,
      existingId: entry.existing?.id ?? null,
      slug: entry.existing?.slug ?? entry.target?.slug ?? null,
      modelNos: entry.target?.variants.map((v) => v.modelNo) ?? [],
      variantCount: entry.target?.variants.length ?? 0,
      newImageCount: entry.imagesToAdd.length,
      variantsRemoved: entry.variantsRemoved,
      changes: entry.changes,
      moreChanges: entry.moreChanges,
      warnings: entry.warnings,
      hash: entry.hash,
    })),
  };
}

/* ------------------------------------------------------------------------ *
 * Commit
 * ------------------------------------------------------------------------ */

/**
 * What the screen does after a failed batch:
 * - preview: the file, the products or a setting changed → preview again;
 * - upload: the default category is gone → start again from step 1;
 * - confirm: variant removals need the admin's confirmation;
 * - retry: try the same batch again (always safe, ADR 0061).
 */
export type CommitNext = "preview" | "upload" | "confirm" | "retry";

export type ImportCommitResult =
  | { ok: true; data: CommitBatchResult }
  | (ActionFailure & { next: CommitNext });

/** How many batches the plan has (same rule as the service's batchCount). */
export function batchTotal(entryCount: number): number {
  return Math.ceil(entryCount / IMPORT_BATCH_SIZE);
}

/** The entries of batch `batch`. */
export function batchEntries<T>(entries: readonly T[], batch: number): T[] {
  return entries.slice(
    batch * IMPORT_BATCH_SIZE,
    (batch + 1) * IMPORT_BATCH_SIZE,
  );
}

/**
 * The batches that write something. A batch whose products are all
 * unchanged or blocked is not sent: the server would only re-read the file
 * to skip them (each batch re-parses the whole workbook).
 */
export function batchesToSend(entries: readonly PreviewEntryView[]): number[] {
  const out: number[] = [];
  for (let batch = 0; batch < batchTotal(entries.length); batch++) {
    if (
      batchEntries(entries, batch).some(
        (e) => e.status === "create" || e.status === "update",
      )
    ) {
      out.push(batch);
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Warnings
 * ------------------------------------------------------------------------ */

/** A warning together with the product it belongs to (null = file level). */
export interface WarningRow {
  warning: ImportWarning;
  product: string | null;
}

/** File-level findings first, then each product's, in sheet order. */
export function allWarnings(plan: PlanView): WarningRow[] {
  return [
    ...plan.fileWarnings.map((warning) => ({ warning, product: null })),
    ...plan.entries.flatMap((entry) =>
      entry.warnings.map((warning) => ({ warning, product: entry.name })),
    ),
  ];
}

export interface WarningFilter {
  severity: WarningSeverity | "all";
  code: WarningCode | "all";
}

export function filterWarnings(
  rows: readonly WarningRow[],
  filter: WarningFilter,
): WarningRow[] {
  return rows.filter(
    ({ warning }) =>
      (filter.severity === "all" || warning.severity === filter.severity) &&
      (filter.code === "all" || warning.code === filter.code),
  );
}

/** The codes present, with how often each occurs, most frequent first. */
export function warningCodeCounts(
  rows: readonly WarningRow[],
): { code: WarningCode; count: number }[] {
  const counts = new Map<WarningCode, number>();
  for (const { warning } of rows) {
    counts.set(warning.code, (counts.get(warning.code) ?? 0) + 1);
  }
  return [...counts]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function severityCounts(
  rows: readonly WarningRow[],
): Record<WarningSeverity, number> {
  const counts: Record<WarningSeverity, number> = {
    fatal: 0,
    error: 0,
    warning: 0,
  };
  for (const { warning } of rows) counts[warning.severity]++;
  return counts;
}

/* ------------------------------------------------------------------------ *
 * Product table
 * ------------------------------------------------------------------------ */

export interface EntryFilter {
  status: PlanStatus | "all";
  /** Matches the name, family, NO. or any model no., any case. */
  q: string;
}

export function filterEntries(
  entries: readonly PreviewEntryView[],
  filter: EntryFilter,
): PreviewEntryView[] {
  const q = filter.q.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter.status !== "all" && entry.status !== filter.status) return false;
    if (q === "") return true;
    return (
      entry.name.toLowerCase().includes(q) ||
      (entry.family?.toLowerCase().includes(q) ?? false) ||
      String(entry.productNo ?? "") === q ||
      entry.modelNos.some((m) => m.toLowerCase().includes(q))
    );
  });
}

/** Page size of the long client-side tables. */
export const IMPORT_PAGE_SIZE = 50;

export function pageOf<T>(
  rows: readonly T[],
  page: number,
): { rows: T[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(rows.length / IMPORT_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  return {
    rows: rows.slice(
      (current - 1) * IMPORT_PAGE_SIZE,
      current * IMPORT_PAGE_SIZE,
    ),
    page: current,
    pageCount,
  };
}

/**
 * True when the change is to a spec column that is restricted now (its
 * values are shown only to approved customers). `field` is "specs.<key>" or
 * "variants.<modelNo>.specs.<key>".
 */
export function isRestrictedChange(
  change: PlanChange,
  restricted: ReadonlySet<string>,
): boolean {
  const match = /(?:^|\.)specs\.([A-Za-z]+)$/.exec(change.field);
  return match !== null && restricted.has(match[1] as string);
}
