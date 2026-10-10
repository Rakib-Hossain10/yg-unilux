"use client";

// Access card on the customer page (plan Q5): where datasheet access stands,
// and set or extend it: 3 / 6 / 12 months (counted from the later of today
// and the current end), a custom last day, or no expiry, with the optional
// "access extended" email. Never touches the invite. Same Zod schema as the
// server, which re-validates the raw values.
//
// "End access now" (shown only while access runs) locks downloads at once
// after a confirm. It is not a block: sign-in keeps working and no email
// goes out; extending access later restores it.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleOff } from "lucide-react";
import { useEffect, useRef, type FormEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";

import {
  endAccessAction,
  setCustomerAccessAction,
} from "@/app/admin/customers/actions";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import type { AccessChoice } from "@/lib/access-expiry";
import { setCustomerAccessSchema } from "@/lib/schemas/customer";
import { formatDateTime } from "@/lib/time-zone";

import { ExpiryPicker } from "../access-requests/expiry-picker";
import { formatAccessEnd } from "../access-requests/format";
import { ActionFeedback } from "./action-feedback";
import { accessSentence, type AccessStateView } from "./labels";
import { useCustomerAction } from "./use-customer-action";

type AccessValues = z.input<typeof setCustomerAccessSchema>;
type AccessParsed = z.output<typeof setCustomerAccessSchema>;

/* The custom-day message from a discriminated-union error. */
function accessError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const nested = (error as { date?: { message?: string } }).date?.message;
  return nested ?? (error as { message?: string }).message;
}

export function AccessCard({
  userId,
  access,
  accessExpiresAt,
  blocked,
}: {
  userId: string;
  access: AccessStateView;
  /** ISO end, or null for no expiry. */
  accessExpiresAt: string | null;
  blocked: boolean;
}) {
  const form = useForm<AccessValues, unknown, AccessParsed>({
    resolver: zodResolver(setCustomerAccessSchema),
    defaultValues: {
      userId,
      access: { kind: "months", months: 12 },
      notify: true,
    },
  });
  const save = useCustomerAction();
  const end = useCustomerAction();
  // Running access: a future end or no expiry at all.
  const running = access !== "expired";
  // The End button unmounts once the refresh shows access ended: focus then
  // lands on Save (enabled again by then), not on <body>.
  const saveButton = useRef<HTMLButtonElement>(null);
  const focusAfterEnd = useRef(false);
  useEffect(() => {
    if (running || !focusAfterEnd.current) return;
    focusAfterEnd.current = false;
    saveButton.current?.focus();
  }, [running, end.pending]);

  const submitValid = () => {
    const values = form.getValues();
    end.clear();
    save.run(
      () => setCustomerAccessAction(values),
      (result) =>
        `Access saved: ${formatAccessEnd(result.data.accessExpiresAt)}.${
          result.data.notified
            ? " The customer was emailed their new end date."
            : ""
        }`,
    );
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  return (
    <Card>
      <form
        noValidate
        aria-busy={save.pending || end.pending}
        onSubmit={onSubmit}
      >
        <CardHeader>
          <CardTitle>
            <h2>Datasheet access</h2>
          </CardTitle>
          <CardDescription>
            {accessSentence(access, accessExpiresAt)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-4">
          {blocked ? (
            <Alert role="note">
              <AlertTitle>This customer is blocked</AlertTitle>
              <AlertDescription>
                Changing the end date does not unblock them, and no email goes
                out while they are blocked.
              </AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Controller
              name="access"
              control={form.control}
              render={({ field, fieldState }) => (
                <ExpiryPicker
                  value={field.value as AccessChoice}
                  onChange={field.onChange}
                  current={accessExpiresAt}
                  error={accessError(fieldState.error)}
                  legend="Set or extend access"
                />
              )}
            />
            <Controller
              name="notify"
              control={form.control}
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Checkbox
                    id="access-notify"
                    checked={field.value ?? true}
                    onCheckedChange={(checked) =>
                      field.onChange(checked === true)
                    }
                  />
                  <FieldLabel htmlFor="access-notify" className="font-normal">
                    Email the customer when access is extended
                  </FieldLabel>
                </Field>
              )}
            />
          </FieldGroup>
          <ActionFeedback
            status={save.status}
            errors={save.errors}
            saved={save.saved}
            failedTitle="Access was not changed"
          />
          <ActionFeedback
            status={end.status}
            errors={end.errors}
            saved={end.saved}
            failedTitle="Access was not ended"
          />
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button
            ref={saveButton}
            type="submit"
            disabled={save.pending || end.pending}
          >
            {save.pending ? "Saving…" : "Save access"}
          </Button>
          {running ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  disabled={end.pending || save.pending}
                >
                  <CircleOff data-icon="inline-start" aria-hidden="true" />
                  {end.pending ? "Ending access…" : "End access now…"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>End datasheet access now?</AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="flex flex-col gap-2">
                      <p>
                        Access to every datasheet ends immediately. The customer
                        can still sign in, and no email is sent.
                      </p>
                      <p>
                        To stop them signing in, use Block. To give access back
                        later, extend it here.
                      </p>
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => {
                      save.clear();
                      end.run(
                        () => endAccessAction({ userId }),
                        (result) => {
                          focusAfterEnd.current = true;
                          return result.data.alreadyEnded
                            ? "Access had already ended."
                            : `Access ended on ${formatDateTime(result.data.accessExpiresAt)}.`;
                        },
                      );
                    }}
                  >
                    End access now
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  );
}
