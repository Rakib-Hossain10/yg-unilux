// One import finding as the admin reads it: severity, title, where it is in
// the sheet, the server's detail and what to do. The detail may repeat cell
// values: it is rendered here and nowhere else (never logged or stored).
// No hooks, so server and client components can both render it.

import { Badge } from "@/components/ui/badge";
import type { ImportWarning } from "@/lib/import/types";

import {
  IMPORT_TEMPLATE_URL,
  SEVERITY_LABELS,
  WARNING_LABELS,
  warningPlace,
} from "./import-labels";

/* Codes whose fix is a fresh template download. */
const TEMPLATE_HINT_CODES = new Set<ImportWarning["code"]>([
  "unknown_area",
  "unknown_category",
  "invalid_area_flag",
  "no_header",
  "missing_required_column",
  "unknown_column",
]);

export function WarningItem({
  warning,
  product,
}: {
  warning: ImportWarning;
  /** The product's name, or null for a finding about the file or a sheet. */
  product?: string | null;
}) {
  const label = WARNING_LABELS[warning.code];
  return (
    <div className="flex flex-col gap-1" data-warning-code={warning.code}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={warning.severity === "warning" ? "outline" : "destructive"}
        >
          {SEVERITY_LABELS[warning.severity]}
        </Badge>
        <span className="font-medium">{label.title}</span>
      </div>
      <p className="text-muted-foreground">
        {product ? `${product} · ` : null}
        {warningPlace(warning)}
      </p>
      {warning.detail ? <p>{warning.detail}</p> : null}
      {label.hint ? (
        <p className="text-muted-foreground">
          {label.hint}
          {TEMPLATE_HINT_CODES.has(warning.code) ? (
            <>
              {" "}
              <a href={IMPORT_TEMPLATE_URL} download className="underline">
                Download the template
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
