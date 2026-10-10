// The feedback under a customer-page action: a polite status line (always
// mounted, so a change is announced) and an alert for a failure. A failure
// that was saved anyway (the audit entry failed) reads as "Saved, with a
// problem".

import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ActionFeedback({
  status,
  errors,
  failedTitle,
  saved = false,
}: {
  status: string;
  errors: string[];
  /** e.g. "The customer was not blocked". */
  failedTitle: string;
  saved?: boolean | "unknown";
}) {
  return (
    <>
      <p role="status" aria-live="polite" className="text-sm">
        {status}
      </p>
      {errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {saved === true
              ? "Saved, with a problem"
              : saved === "unknown"
                ? "The change could not be confirmed"
                : failedTitle}
          </AlertTitle>
          <AlertDescription>{errors.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
