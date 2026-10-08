"use client";

// Step 2 of the import (T9): what the file would do. A refused file shows
// why; otherwise the counts, the file-level findings, the product table and
// every warning, then the removal confirmation and "Save". Nothing has been
// written at this point (ADR 0057: the preview writes nothing).

import { CircleAlert, TriangleAlert } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { plural } from "./import-labels";
import { ImportProductsTable } from "./import-products-table";
import {
  allWarnings,
  type ImportPreviewView,
  type PlanView,
} from "./import-view";
import { ImportWarnings } from "./import-warnings";
import { WarningItem } from "./warning-item";

/** The file was refused as a whole: why, and how to fix it. */
export function RefusedFile({
  warnings,
  onStartOver,
}: {
  warnings: Extract<ImportPreviewView, { kind: "refused" }>["warnings"];
  onStartOver: () => void;
}) {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Alert variant="destructive" role="alert">
        <CircleAlert aria-hidden="true" />
        <AlertTitle>This file can&apos;t be imported</AlertTitle>
        <AlertDescription>
          Nothing was saved. Fix the problem below and upload the file again.
        </AlertDescription>
      </Alert>
      <ul className="flex flex-col divide-y rounded-lg border text-sm">
        {warnings.map((warning, index) => (
          <li key={index} className="p-3">
            <WarningItem warning={warning} />
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" onClick={onStartOver}>
          Choose another file
        </Button>
      </div>
    </div>
  );
}

/** The plan's counts as a definition list. */
export function PlanSummary({ plan }: { plan: PlanView }) {
  const { summary } = plan;
  const items: [string, number][] = [
    ["New products", summary.create],
    ["Products to update", summary.update],
    ["Unchanged", summary.unchanged],
    ["Blocked (not saved)", summary.blocked],
    ["Pictures to add", summary.imagesToAdd],
    ["Variants to remove", summary.variantsRemoved],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-1 rounded-lg border p-3">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="text-2xl font-semibold tabular-nums">
            {value.toLocaleString("en-US")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ImportPreviewStep({
  fileName,
  plan,
  restrictedColumns,
  onSave,
  onStartOver,
}: {
  fileName: string;
  plan: PlanView;
  restrictedColumns: readonly string[];
  onSave: (acknowledgeRemovals: boolean) => void;
  onStartOver: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackError, setAckError] = useState(false);
  const ackId = useId();
  const warningRows = useMemo(() => allWarnings(plan), [plan]);
  const { summary } = plan;
  const toSave = summary.create + summary.update;
  const removals = summary.variantsRemoved;

  const save = () => {
    if (removals > 0 && !acknowledged) {
      setAckError(true);
      document.getElementById(ackId)?.focus();
      return;
    }
    onSave(removals > 0 && acknowledged);
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        {fileName}: {plural(plan.entries.length, "product")} found. Nothing has
        been saved yet.
      </p>

      <PlanSummary plan={plan} />

      {plan.fileWarnings.length > 0 ? (
        <Alert>
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>About the file</AlertTitle>
          <AlertDescription>
            <ul className="flex w-full flex-col gap-3">
              {plan.fileWarnings.map((warning, index) => (
                <li key={index}>
                  <WarningItem warning={warning} />
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">
            Products ({plan.entries.length.toLocaleString("en-US")})
          </TabsTrigger>
          <TabsTrigger value="warnings">
            Warnings ({warningRows.length.toLocaleString("en-US")})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="pt-4">
          <ImportProductsTable
            entries={plan.entries}
            restrictedColumns={restrictedColumns}
          />
        </TabsContent>
        <TabsContent value="warnings" className="pt-4">
          <ImportWarnings rows={warningRows} />
        </TabsContent>
      </Tabs>

      <section
        aria-labelledby="import-save-heading"
        className="flex max-w-3xl flex-col gap-4 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10 sm:p-6"
      >
        <h3 id="import-save-heading" className="text-lg font-semibold">
          Save
        </h3>
        {toSave === 0 ? (
          <p>
            There is nothing to save: every product is unchanged or blocked. Fix
            blocked products in the sheet and upload it again.
          </p>
        ) : (
          <p>
            {plural(summary.create, "new product")} will be saved as drafts and{" "}
            {plural(summary.update, "product")} will be updated.
            {summary.blocked > 0
              ? ` ${plural(summary.blocked, "blocked product")} will be skipped.`
              : ""}{" "}
            Large files are saved in batches; keep this page open until it
            finishes.
          </p>
        )}

        {removals > 0 && toSave > 0 ? (
          <Field orientation="horizontal" data-invalid={ackError || undefined}>
            <Checkbox
              id={ackId}
              checked={acknowledged}
              onCheckedChange={(value) => {
                setAcknowledged(value === true);
                if (value === true) setAckError(false);
              }}
              aria-invalid={ackError || undefined}
              aria-describedby={`${ackId}-help`}
            />
            <FieldContent>
              <FieldLabel htmlFor={ackId}>
                Remove {plural(removals, "variant")} that{" "}
                {removals === 1 ? "is" : "are"} not in the sheet
              </FieldLabel>
              <FieldDescription id={`${ackId}-help`}>
                {ackError
                  ? "Confirm the removal to save. To keep those variants, add them to the sheet and upload it again."
                  : "Open a product's details to see which variants. Removed variants can't be restored."}
              </FieldDescription>
            </FieldContent>
          </Field>
        ) : null}

        <div className="flex flex-wrap gap-3">
          {toSave > 0 ? (
            <Button type="button" onClick={save}>
              Save {plural(toSave, "product")}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onStartOver}>
            Choose another file
          </Button>
        </div>
      </section>
    </div>
  );
}
