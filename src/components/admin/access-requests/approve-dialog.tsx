"use client";

// The approve dialog (plan Q1, Q5): for a new customer the admin may correct
// name / company / country, picks the access end and how the invite link
// travels; for an existing customer access is extended instead (never a
// second account). After saving, the dialog shows the outcome, including a
// copy-once link, which lives only in this component's state and is dropped
// when the dialog closes. Same Zod schema as the server, which re-validates.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
import {
  Controller,
  useForm,
  useWatch,
  type UseFormReturn,
} from "react-hook-form";
import type { z } from "zod";

import { approveAccessRequestAction } from "@/app/admin/access-requests/actions";
import { COUNTRIES } from "@/components/site/request-access/countries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { AccessChoice } from "@/lib/access-expiry";
import {
  approveAccessRequestSchema,
  MAX_COMPANY_LENGTH,
  MAX_COUNTRY_LENGTH,
  MAX_NAME_LENGTH,
} from "@/lib/schemas/access-request";

import { callAction, type ServiceErrors } from "../action-result";
import { ExpiryPicker } from "./expiry-picker";
import { formatAccessEnd, formatDayTime } from "./format";
import {
  AuditFailedAlert,
  InviteOutcomeView,
  NewInviteLink,
  UnverifiedContactWarning,
} from "./invite-result";
import { inviteNeedsRetry, type ApproveOutcome } from "./types";

/** The request as the dialog needs it (plain JSON). */
export interface ApproveRequestData {
  id: string;
  name: string;
  email: string;
  company: string | null;
  country: string | null;
  source: string;
  existing: {
    userId: string;
    isCustomer: boolean;
    blocked: boolean;
    accessExpiresAt: string | null;
    invite:
      | { state: "none" }
      | { state: "pending"; until: string }
      | { state: "expired" }
      | { state: "accepted" };
  } | null;
}

type ApproveValues = z.input<typeof approveAccessRequestSchema>;
type ApproveParsed = z.output<typeof approveAccessRequestSchema>;

const DEFAULT_ACCESS: AccessChoice = { kind: "months", months: 12 };

function defaults(request: ApproveRequestData): ApproveValues {
  return {
    requestId: request.id,
    name: request.name,
    company: request.company ?? "",
    country: request.country ?? "",
    access: DEFAULT_ACCESS,
    // Email by default; copying is a deliberate second choice (gate A L-3).
    delivery: "email",
    notifyExtension: true,
  };
}

const PROFILE_FIELDS = ["name", "company", "country"] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];
const isProfileField = (key: string): key is ProfileField =>
  (PROFILE_FIELDS as readonly string[]).includes(key);

function applyServerErrors(
  form: Pick<UseFormReturn<ApproveValues, unknown, ApproveParsed>, "setError">,
  errors: ServiceErrors,
  /** False for an existing customer: the profile inputs are not shown. */
  profileShown: boolean,
): string[] {
  const messages = [...errors.formErrors];
  for (const [key, list] of Object.entries(errors.fieldErrors)) {
    const message = list[0];
    if (message === undefined) continue;
    if (profileShown && isProfileField(key)) {
      form.setError(key, { type: "server", message });
    } else {
      messages.push(message);
    }
  }
  return messages;
}

/* The custom-day message from a discriminated-union error. */
function accessError(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const nested = (error as { date?: { message?: string } }).date?.message;
  return nested ?? (error as { message?: string }).message;
}

export function ApproveDialog({
  request,
  open,
  onOpenChange,
  onApproved,
}: {
  request: ApproveRequestData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Told once the approval is saved (for the page's status line). */
  onApproved: (outcome: ApproveOutcome) => void;
}) {
  const existing = request.existing;
  const isExistingCustomer = existing?.isCustomer === true;
  const refused = existing !== null && !existing.isCustomer;
  // An invite goes out for a new account, or when the last one expired.
  const inviteDue = existing === null || existing.invite.state === "expired";
  const unverified = request.source === "form";

  const form = useForm<ApproveValues, unknown, ApproveParsed>({
    resolver: zodResolver(approveAccessRequestSchema),
    defaultValues: defaults(request),
  });
  const delivery = useWatch({ control: form.control, name: "delivery" });
  const [outcome, setOutcome] = useState<ApproveOutcome | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);

  const reset = () => {
    form.reset(defaults(request));
    setOutcome(null);
    setFormErrors([]);
    setSaved(false);
  };

  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    /*
     * The raw form values go to the server, which parses the same schema.
     * The parsed output would not parse again (an empty company becomes null).
     */
    const values = form.getValues();
    startTransition(async () => {
      try {
        const result = await callAction(() =>
          approveAccessRequestAction(values),
        );
        if (!result) return;
        if (result.ok) {
          setOutcome(result.data);
          onApproved(result.data);
          return;
        }
        setSaved(result.saved);
        setFormErrors(
          applyServerErrors(form, result.errors, !isExistingCustomer),
        );
      } finally {
        inFlight.current = false;
      }
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  const profileInput = (
    name: ProfileField,
    label: string,
    maxLength: number,
    optional: boolean,
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => {
        const id = `approve-${name}`;
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={id}>
              {label}
              {optional ? (
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              ) : null}
            </FieldLabel>
            <Input
              {...field}
              value={field.value ?? ""}
              name={undefined}
              id={id}
              autoComplete="off"
              maxLength={maxLength}
              list={name === "country" ? "approve-country-options" : undefined}
              aria-invalid={fieldState.invalid}
              aria-describedby={fieldState.invalid ? `${id}-error` : undefined}
            />
            <FieldError id={`${id}-error`} errors={[fieldState.error]} />
          </Field>
        );
      }}
    />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        // Closing drops the outcome, and with it any copy-once link.
        reset();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        {outcome !== null ? (
          <ApproveOutcomeView
            outcome={outcome}
            email={request.email}
            unverified={unverified}
            onClose={() => {
              onOpenChange(false);
              reset();
            }}
          />
        ) : (
          <form
            noValidate
            aria-busy={pending}
            onSubmit={onSubmit}
            className="flex flex-col gap-4"
          >
            <DialogHeader>
              <DialogTitle>Approve request</DialogTitle>
              <DialogDescription>
                {isExistingCustomer
                  ? `${request.email} is already a customer. Approving extends their access; no second account is made.`
                  : `Creates a customer account for ${request.email} and sends an invite link to set a password.`}
              </DialogDescription>
            </DialogHeader>

            {refused ? (
              <Alert variant="destructive" role="alert">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>This request can&apos;t be approved</AlertTitle>
                <AlertDescription>
                  This email belongs to an account that is not a customer (for
                  example the admin account). Reject the request instead.
                </AlertDescription>
              </Alert>
            ) : null}

            {isExistingCustomer ? (
              <Alert role="note">
                <Info aria-hidden="true" />
                <AlertTitle>Existing customer</AlertTitle>
                <AlertDescription>
                  <p>
                    Access today: {formatAccessEnd(existing.accessExpiresAt)}.
                    Month choices count from the later of today and that date.
                  </p>
                  {existing.invite.state === "pending" ? (
                    <p>
                      Their invite link is still valid until{" "}
                      {formatDayTime(existing.invite.until)}; no new one is
                      sent.
                    </p>
                  ) : null}
                  {existing.invite.state === "expired" ? (
                    <p>Their invite link expired, so a new one is sent.</p>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}

            {isExistingCustomer && existing.blocked ? (
              <Alert variant="destructive" role="note">
                <TriangleAlert aria-hidden="true" />
                <AlertTitle>This customer is blocked</AlertTitle>
                <AlertDescription>
                  Approving extends their access but does not unblock them, and
                  no invite link is made while they are blocked. Unblock them on
                  the customer page first if they should download again.
                </AlertDescription>
              </Alert>
            ) : null}

            {formErrors.length > 0 ? (
              <Alert variant="destructive" role="alert">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>
                  {saved === "unknown"
                    ? "The approval could not be confirmed"
                    : "The request was not approved"}
                </AlertTitle>
                <AlertDescription>{formErrors.join(" ")}</AlertDescription>
              </Alert>
            ) : null}

            {refused ? null : (
              <FieldGroup>
                {isExistingCustomer ? null : (
                  <>
                    {profileInput("name", "Name", MAX_NAME_LENGTH, false)}
                    {profileInput(
                      "company",
                      "Company",
                      MAX_COMPANY_LENGTH,
                      true,
                    )}
                    {profileInput(
                      "country",
                      "Country",
                      MAX_COUNTRY_LENGTH,
                      true,
                    )}
                    <datalist id="approve-country-options">
                      {COUNTRIES.map((country) => (
                        <option key={country} value={country} />
                      ))}
                    </datalist>
                  </>
                )}

                <Controller
                  name="access"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <ExpiryPicker
                      value={field.value as AccessChoice}
                      onChange={field.onChange}
                      current={
                        isExistingCustomer ? existing.accessExpiresAt : null
                      }
                      error={accessError(fieldState.error)}
                      legend={
                        isExistingCustomer
                          ? "Extend access"
                          : "Access to datasheets"
                      }
                    />
                  )}
                />

                {inviteDue && !(isExistingCustomer && existing.blocked) ? (
                  <Controller
                    name="delivery"
                    control={form.control}
                    render={({ field }) => (
                      <FieldSet>
                        <FieldLegend variant="label">Invite link</FieldLegend>
                        <RadioGroup
                          value={field.value ?? "email"}
                          onValueChange={field.onChange}
                          className="flex flex-col gap-3"
                        >
                          <Field orientation="horizontal">
                            <RadioGroupItem
                              value="email"
                              id="approve-delivery-email"
                            />
                            <FieldLabel
                              htmlFor="approve-delivery-email"
                              className="font-normal"
                            >
                              Email it to {request.email}
                            </FieldLabel>
                          </Field>
                          <Field orientation="horizontal">
                            <RadioGroupItem
                              value="copy"
                              id="approve-delivery-copy"
                            />
                            <FieldLabel
                              htmlFor="approve-delivery-copy"
                              className="font-normal"
                            >
                              Show once to copy (for WhatsApp)
                            </FieldLabel>
                          </Field>
                        </RadioGroup>
                      </FieldSet>
                    )}
                  />
                ) : null}

                {delivery === "copy" && unverified && inviteDue ? (
                  <UnverifiedContactWarning />
                ) : null}

                {isExistingCustomer ? (
                  <Controller
                    name="notifyExtension"
                    control={form.control}
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <Checkbox
                          id="approve-notify"
                          checked={field.value ?? true}
                          onCheckedChange={(checked) =>
                            field.onChange(checked === true)
                          }
                        />
                        <FieldLabel
                          htmlFor="approve-notify"
                          className="font-normal"
                        >
                          Email the customer their new end date
                        </FieldLabel>
                      </Field>
                    )}
                  />
                ) : null}
              </FieldGroup>
            )}

            <DialogFooter>
              <Button
                type="submit"
                disabled={pending || refused || saved !== false}
              >
                {pending
                  ? "Approving…"
                  : isExistingCustomer
                    ? "Approve and extend access"
                    : "Approve and create account"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* What the approval did, shown in place of the form. */
function ApproveOutcomeView({
  outcome,
  email,
  unverified,
  onClose,
}: {
  outcome: ApproveOutcome;
  email: string;
  unverified: boolean;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Request approved</DialogTitle>
        <DialogDescription>
          {outcome.created
            ? `A customer account was created for ${email}. Access ${formatAccessEnd(outcome.accessExpiresAt)}.`
            : `${email} was already a customer. Access is now ${formatAccessEnd(outcome.accessExpiresAt)}.`}
        </DialogDescription>
      </DialogHeader>

      {outcome.auditMessage ? (
        <AuditFailedAlert message={outcome.auditMessage} />
      ) : null}

      {outcome.invite !== null ? (
        <InviteOutcomeView invite={outcome.invite} />
      ) : null}
      {inviteNeedsRetry(outcome.invite) ? (
        <NewInviteLink userId={outcome.userId} unverified={unverified} />
      ) : null}

      {outcome.inviteWithheld ? (
        <Alert variant="destructive" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>No invite link was made</AlertTitle>
          <AlertDescription>
            This customer is blocked. Unblock them on the customer page, then
            send a new invite link from there.
          </AlertDescription>
        </Alert>
      ) : outcome.blocked ? (
        <Alert variant="destructive" role="note">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This customer is still blocked</AlertTitle>
          <AlertDescription>
            They can&apos;t download until you unblock them on the customer
            page.
          </AlertDescription>
        </Alert>
      ) : null}

      {!outcome.created ? (
        <p className="text-sm text-muted-foreground">
          {outcome.notified
            ? "The customer was emailed their new end date."
            : "No end-date email was sent."}
          {outcome.invite === null && !outcome.inviteWithheld
            ? " No invite link was needed: they already have a password or a valid link."
            : ""}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}
