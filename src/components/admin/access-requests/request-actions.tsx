"use client";

// The actions on one request's page: Approve and Reject while it is pending,
// Delete once it is handled. The approve dialog stays mounted after the page
// refreshes to "Approved", so its outcome (and a copy-once link) stays on
// screen until the admin closes it. A polite status line confirms each step.

import { zodResolver } from "@hookform/resolvers/zod";
import { Check, CircleAlert, Trash2, X } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";

import {
  deleteAccessRequestAction,
  rejectAccessRequestAction,
} from "@/app/admin/access-requests/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { rejectAccessRequestSchema } from "@/lib/schemas/access-request";

import { allMessages, callAction } from "../action-result";
import { ApproveDialog, type ApproveRequestData } from "./approve-dialog";
import { AuditFailedAlert } from "./invite-result";

type RejectValues = z.input<typeof rejectAccessRequestSchema>;
type RejectParsed = z.output<typeof rejectAccessRequestSchema>;

export function RequestActions({
  request,
  status,
}: {
  request: ApproveRequestData;
  status: string;
}) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [message, setMessage] = useState("");
  // Outlives the reject dialog, which unmounts once the page shows "Rejected".
  const [auditProblem, setAuditProblem] = useState<string | null>(null);
  const pending = status === "pending";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {pending ? (
          <>
            <Button type="button" onClick={() => setApproveOpen(true)}>
              <Check data-icon="inline-start" aria-hidden="true" />
              Approve…
            </Button>
            <RejectDialog
              requestId={request.id}
              onRejected={setMessage}
              onSavedWithProblem={(problem) => {
                setMessage("Request rejected.");
                setAuditProblem(problem);
              }}
            />
          </>
        ) : (
          <DeleteRequestButton requestId={request.id} />
        )}
      </div>
      {/* Always mounted, so a change is announced. */}
      <p role="status" aria-live="polite" className="text-sm">
        {message}
      </p>
      {auditProblem ? <AuditFailedAlert message={auditProblem} /> : null}
      <ApproveDialog
        request={request}
        open={approveOpen}
        onOpenChange={setApproveOpen}
        onApproved={(outcome) =>
          setMessage(
            outcome.created
              ? "Request approved. Customer account created."
              : "Request approved. Access extended.",
          )
        }
      />
    </div>
  );
}

function RejectDialog({
  requestId,
  onRejected,
  onSavedWithProblem,
}: {
  requestId: string;
  onRejected: (message: string) => void;
  /** Rejected, but the audit entry failed (the page refreshes to "Rejected"). */
  onSavedWithProblem: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const empty: RejectValues = { requestId, reason: "", sendEmail: false };
  const form = useForm<RejectValues, unknown, RejectParsed>({
    resolver: zodResolver(rejectAccessRequestSchema),
    defaultValues: empty,
  });

  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    /*
     * The raw form values go to the server, which parses the same schema.
     * The parsed output would not parse again (an empty reason becomes null).
     */
    const values = form.getValues();
    startTransition(async () => {
      try {
        const result = await callAction(() =>
          rejectAccessRequestAction(values),
        );
        if (!result) return;
        if (result.ok) {
          setOpen(false);
          onRejected(
            values.sendEmail
              ? result.data.emailSent
                ? "Request rejected. The decline email was sent."
                : "Request rejected, but the decline email could not be sent."
              : "Request rejected. No email was sent.",
          );
          return;
        }
        if (result.saved === true) {
          setOpen(false);
          onSavedWithProblem(allMessages(result.errors).join(" "));
          return;
        }
        const reasonError = result.errors.fieldErrors.reason?.[0];
        if (reasonError !== undefined) {
          form.setError("reason", { type: "server", message: reasonError });
        }
        setSaved(result.saved);
        setFormErrors(
          reasonError === undefined
            ? allMessages(result.errors)
            : result.errors.formErrors,
        );
      } finally {
        inFlight.current = false;
      }
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) {
          form.reset(empty);
          setFormErrors([]);
          setSaved(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <X data-icon="inline-start" aria-hidden="true" />
          Reject…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          noValidate
          aria-busy={pending}
          onSubmit={onSubmit}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Reject request</DialogTitle>
            <DialogDescription>
              The request moves to the handled list. Nothing is emailed unless
              you tick the box below.
            </DialogDescription>
          </DialogHeader>

          {formErrors.length > 0 ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>
                {saved === "unknown"
                  ? "The rejection could not be confirmed"
                  : "The request was not rejected"}
              </AlertTitle>
              <AlertDescription>{formErrors.join(" ")}</AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup>
            <Controller
              name="reason"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="reject-reason">
                    Reason
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </FieldLabel>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    name={undefined}
                    id="reject-reason"
                    rows={3}
                    aria-invalid={fieldState.invalid}
                    aria-describedby={`reject-reason-help${fieldState.invalid ? " reject-reason-error" : ""}`}
                  />
                  <FieldDescription id="reject-reason-help">
                    For your records only. It is never shown or emailed to the
                    requester.
                  </FieldDescription>
                  <FieldError
                    id="reject-reason-error"
                    errors={[fieldState.error]}
                  />
                </Field>
              )}
            />
            <Controller
              name="sendEmail"
              control={form.control}
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Checkbox
                    id="reject-send-email"
                    checked={field.value ?? false}
                    onCheckedChange={(checked) =>
                      field.onChange(checked === true)
                    }
                  />
                  <FieldLabel
                    htmlFor="reject-send-email"
                    className="font-normal"
                  >
                    Send a polite decline email
                  </FieldLabel>
                </Field>
              )}
            />
          </FieldGroup>

          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              disabled={pending || saved !== false}
            >
              {pending ? "Rejecting…" : "Reject request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRequestButton({ requestId }: { requestId: string }) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const inFlight = useRef(false);

  const remove = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setErrors([]);
    startTransition(async () => {
      try {
        // On success the action redirects to the handled list.
        const result = await callAction(() =>
          deleteAccessRequestAction({ requestId }),
        );
        if (!result || result.ok) return;
        setSaved(result.saved);
        setErrors(allMessages(result.errors));
      } finally {
        inFlight.current = false;
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={pending || saved === true}
          >
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            {pending ? "Deleting…" : "Delete request…"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this request?</AlertDialogTitle>
            <AlertDialogDescription>
              The request and the details in it are removed for good. A customer
              account made from it is not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {saved === true && errors.length > 0 ? (
        <AuditFailedAlert message={errors.join(" ")} />
      ) : errors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {saved === "unknown"
              ? "The delete could not be confirmed"
              : "The request was not deleted"}
          </AlertTitle>
          <AlertDescription>{errors.join(" ")}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
