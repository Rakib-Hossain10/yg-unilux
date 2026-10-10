"use client";

// Sign-in card on the customer page: block with a reason (internal only;
// their sessions end at once), unblock, and "Sign out everywhere". Nothing is
// deleted: blocking keeps the download history and the audit trail. Same Zod
// schema as the server, which re-validates the raw values.

import { zodResolver } from "@hookform/resolvers/zod";
import { Ban, LogOut, Unlock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";

import {
  banCustomerAction,
  revokeCustomerSessionsAction,
  unbanCustomerAction,
} from "@/app/admin/customers/actions";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { banCustomerSchema } from "@/lib/schemas/customer";

import { ActionFeedback } from "./action-feedback";
import { useCustomerAction } from "./use-customer-action";

type BanValues = z.input<typeof banCustomerSchema>;
type BanParsed = z.output<typeof banCustomerSchema>;

export function BlockCard({
  userId,
  blocked,
  banReason,
  reasonMaxLength,
}: {
  userId: string;
  blocked: boolean;
  banReason: string | null;
  /** The schema's cap, passed from the server page. */
  reasonMaxLength: number;
}) {
  const unban = useCustomerAction();
  const sessions = useCustomerAction();
  const [blockedMessage, setBlockedMessage] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="flex flex-wrap items-center gap-2">
            Sign-in
            {blocked ? <Badge variant="destructive">Blocked</Badge> : null}
          </h2>
        </CardTitle>
        <CardDescription>
          {blocked
            ? "This customer can't sign in or download. Their history is kept."
            : "Block a customer who should no longer download. Nothing is deleted."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {blocked ? (
          <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Reason (internal)</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap">
              {banReason ?? "—"}
            </dd>
          </dl>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {blocked ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={unban.pending}
                >
                  <Unlock data-icon="inline-start" aria-hidden="true" />
                  {unban.pending ? "Unblocking…" : "Unblock…"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Unblock this customer?</AlertDialogTitle>
                  <AlertDialogDescription>
                    They can sign in again and download while their access is
                    still running.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      setBlockedMessage("");
                      unban.run(
                        () => unbanCustomerAction({ userId }),
                        "Customer unblocked.",
                      );
                    }}
                  >
                    Unblock
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <BlockDialog
              userId={userId}
              reasonMaxLength={reasonMaxLength}
              onBlocked={setBlockedMessage}
            />
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={sessions.pending}
              >
                <LogOut data-icon="inline-start" aria-hidden="true" />
                {sessions.pending ? "Signing out…" : "Sign out everywhere…"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>End every session?</AlertDialogTitle>
                <AlertDialogDescription>
                  The customer is signed out on every device. They can sign in
                  again with their password unless they are blocked.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    sessions.run(
                      () => revokeCustomerSessionsAction({ userId }),
                      "The customer was signed out everywhere.",
                    )
                  }
                >
                  Sign out everywhere
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <p role="status" aria-live="polite" className="text-sm">
          {blockedMessage}
        </p>
        <ActionFeedback
          status={unban.status}
          errors={unban.errors}
          saved={unban.saved}
          failedTitle="The customer was not unblocked"
        />
        <ActionFeedback
          status={sessions.status}
          errors={sessions.errors}
          saved={sessions.saved}
          failedTitle="The sessions were not ended"
        />
      </CardContent>
    </Card>
  );
}

function BlockDialog({
  userId,
  reasonMaxLength,
  onBlocked,
}: {
  userId: string;
  reasonMaxLength: number;
  onBlocked: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const block = useCustomerAction();
  const empty: BanValues = { userId, reason: "" };
  const form = useForm<BanValues, unknown, BanParsed>({
    resolver: zodResolver(banCustomerSchema),
    defaultValues: empty,
  });

  const submitValid = () => {
    const values = form.getValues();
    block.run(
      () => banCustomerAction(values),
      () => {
        setOpen(false);
        onBlocked("Customer blocked. Their sessions have ended.");
        return "";
      },
      (fieldErrors) => {
        const message = fieldErrors.reason?.[0];
        if (message === undefined) return false;
        form.setError("reason", { type: "server", message });
        return true;
      },
    );
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (block.pending) return;
        setOpen(next);
        if (next) {
          form.reset(empty);
          block.clear();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Ban data-icon="inline-start" aria-hidden="true" />
          Block…
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          noValidate
          aria-busy={block.pending}
          onSubmit={onSubmit}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Block customer</DialogTitle>
            <DialogDescription>
              They are signed out at once and can&apos;t sign in or download
              until you unblock them. Their history is kept.
            </DialogDescription>
          </DialogHeader>
          <ActionFeedback
            status=""
            errors={block.errors}
            saved={block.saved}
            failedTitle="The customer was not blocked"
          />
          <FieldGroup>
            <Controller
              name="reason"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="block-reason">Reason</FieldLabel>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    name={undefined}
                    id="block-reason"
                    rows={3}
                    maxLength={reasonMaxLength}
                    aria-invalid={fieldState.invalid}
                    aria-describedby={`block-reason-help${fieldState.invalid ? " block-reason-error" : ""}`}
                  />
                  <FieldDescription id="block-reason-help">
                    For your records only. It is never shown or emailed to the
                    customer.
                  </FieldDescription>
                  <FieldError
                    id="block-reason-error"
                    errors={[fieldState.error]}
                  />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button
              type="submit"
              variant="destructive"
              disabled={block.pending || block.saved !== false}
            >
              {block.pending ? "Blocking…" : "Block customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
