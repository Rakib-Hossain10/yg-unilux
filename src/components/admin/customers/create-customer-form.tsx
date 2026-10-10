"use client";

// "New customer" (plan Q1, Q5): name, email, company, country, the access
// end and how the invite link travels. No password is ever typed or emailed:
// the customer sets their own through the invite. After saving, the form is
// replaced by the outcome, including a copy-once link that lives only in
// this component's state (never a URL): leaving the page drops it. Same Zod
// schema as the server, which re-validates the raw values.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRef, useState, useTransition, type FormEvent } from "react";
import {
  Controller,
  useForm,
  useWatch,
  type UseFormReturn,
} from "react-hook-form";
import type { z } from "zod";

import {
  createCustomerAction,
  newCustomerInviteAction,
} from "@/app/admin/customers/actions";
import { COUNTRIES } from "@/components/site/request-access/countries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  MAX_COMPANY_LENGTH,
  MAX_COUNTRY_LENGTH,
  MAX_NAME_LENGTH,
} from "@/lib/schemas/access-request";
import { createCustomerSchema } from "@/lib/schemas/customer";

import { callAction, type ServiceErrors } from "../action-result";
import { ExpiryPicker } from "../access-requests/expiry-picker";
import { formatAccessEnd } from "../access-requests/format";
import {
  AuditFailedAlert,
  CopyLinkWarning,
  InviteOutcomeView,
  NewInviteLink,
} from "../access-requests/invite-result";
import { inviteNeedsRetry } from "../access-requests/types";
import { customerPath } from "./paths";
import type { CreateCustomerOutcome } from "./types";

type CreateValues = z.input<typeof createCustomerSchema>;
type CreateParsed = z.output<typeof createCustomerSchema>;

/* The schema caps the email at 254; the input mirrors it. */
const MAX_EMAIL_LENGTH = 254;

const EMPTY: CreateValues = {
  name: "",
  email: "",
  company: "",
  country: "",
  access: { kind: "months", months: 12 },
  // Email by default; copying is a deliberate second choice.
  delivery: "email",
};

const TEXT_FIELDS = ["name", "email", "company", "country"] as const;
type TextField = (typeof TEXT_FIELDS)[number];
const isTextField = (key: string): key is TextField =>
  (TEXT_FIELDS as readonly string[]).includes(key);

/* Field errors under their inputs (focus on the first), the rest above. */
function applyServerErrors(
  form: Pick<UseFormReturn<CreateValues, unknown, CreateParsed>, "setError">,
  errors: ServiceErrors,
): string[] {
  const messages = [...errors.formErrors];
  let focused = false;
  for (const [key, list] of Object.entries(errors.fieldErrors)) {
    const message = list[0];
    if (message === undefined) continue;
    if (isTextField(key)) {
      form.setError(
        key,
        { type: "server", message },
        { shouldFocus: !focused },
      );
      focused = true;
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

export function CreateCustomerForm() {
  const form = useForm<CreateValues, unknown, CreateParsed>({
    resolver: zodResolver(createCustomerSchema),
    defaultValues: EMPTY,
  });
  const [outcome, setOutcome] = useState<
    (CreateCustomerOutcome & { email: string }) | null
  >(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);
  const delivery = useWatch({ control: form.control, name: "delivery" });

  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    /*
     * The raw form values go to the server, which parses the same schema.
     * The parsed output would not parse again (an empty company is null).
     */
    const values = form.getValues();
    startTransition(async () => {
      try {
        const result = await callAction(() => createCustomerAction(values));
        if (!result) return;
        if (result.ok) {
          setOutcome({ ...result.data, email: values.email.trim() });
          return;
        }
        setSaved(result.saved);
        setFormErrors(applyServerErrors(form, result.errors));
      } finally {
        inFlight.current = false;
      }
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  if (outcome !== null) {
    return (
      <section
        aria-labelledby="customer-created-heading"
        className="flex max-w-2xl flex-col gap-4"
      >
        <h2 id="customer-created-heading" className="text-lg font-semibold">
          Customer created
        </h2>
        <p className="text-sm">
          {outcome.email} can download datasheets{" "}
          {outcome.accessExpiresAt === null
            ? "with no expiry"
            : formatAccessEnd(outcome.accessExpiresAt)}{" "}
          once they have set a password.
        </p>
        {outcome.auditMessage ? (
          <AuditFailedAlert message={outcome.auditMessage} />
        ) : null}
        <InviteOutcomeView invite={outcome.invite} />
        {inviteNeedsRetry(outcome.invite) ? (
          <NewInviteLink
            userId={outcome.userId}
            unverified
            warning={<CopyLinkWarning />}
            action={newCustomerInviteAction}
          />
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href={customerPath(outcome.userId)}>Open customer</Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              // Drops the outcome, and with it any copy-once link.
              form.reset(EMPTY);
              setOutcome(null);
              setSaved(false);
            }}
          >
            <UserPlus data-icon="inline-start" aria-hidden="true" />
            Create another
          </Button>
        </div>
      </section>
    );
  }

  const textInput = (
    name: TextField,
    label: string,
    options: {
      maxLength: number;
      optional?: boolean;
      type?: string;
      autoComplete?: string;
    },
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => {
        const id = `customer-${name}`;
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={id}>
              {label}
              {options.optional ? (
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
              type={options.type ?? "text"}
              autoComplete={options.autoComplete ?? "off"}
              maxLength={options.maxLength}
              list={name === "country" ? "customer-country-options" : undefined}
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
    <form
      noValidate
      aria-busy={pending}
      onSubmit={onSubmit}
      className="flex max-w-2xl flex-col gap-6"
    >
      {formErrors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>
            {saved === "unknown"
              ? "The customer could not be confirmed"
              : "The customer was not created"}
          </AlertTitle>
          <AlertDescription>
            {formErrors.join(" ")}
            {saved === "unknown"
              ? " Check the customers list before trying again."
              : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <FieldGroup>
        {textInput("name", "Name", { maxLength: MAX_NAME_LENGTH })}
        {textInput("email", "Email", {
          maxLength: MAX_EMAIL_LENGTH,
          type: "email",
        })}
        {textInput("company", "Company", {
          maxLength: MAX_COMPANY_LENGTH,
          optional: true,
        })}
        {textInput("country", "Country", {
          maxLength: MAX_COUNTRY_LENGTH,
          optional: true,
        })}
        <datalist id="customer-country-options">
          {COUNTRIES.map((country) => (
            <option key={country} value={country} />
          ))}
        </datalist>

        <Controller
          name="access"
          control={form.control}
          render={({ field, fieldState }) => (
            <ExpiryPicker
              value={field.value as AccessChoice}
              onChange={field.onChange}
              current={null}
              error={accessError(fieldState.error)}
            />
          )}
        />

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
                  <RadioGroupItem value="email" id="customer-delivery-email" />
                  <FieldLabel
                    htmlFor="customer-delivery-email"
                    className="font-normal"
                  >
                    Email it to the customer
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <RadioGroupItem value="copy" id="customer-delivery-copy" />
                  <FieldLabel
                    htmlFor="customer-delivery-copy"
                    className="font-normal"
                  >
                    Show once to copy (for WhatsApp)
                  </FieldLabel>
                </Field>
              </RadioGroup>
            </FieldSet>
          )}
        />
        {delivery === "copy" ? <CopyLinkWarning /> : null}
      </FieldGroup>

      <div>
        <Button type="submit" disabled={pending || saved !== false}>
          {pending ? "Creating…" : "Create customer"}
        </Button>
      </div>
    </form>
  );
}
