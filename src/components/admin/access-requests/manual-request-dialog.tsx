"use client";

// "Add WhatsApp request": the admin types in a request that arrived on
// WhatsApp (source "whatsapp", pending). Same Zod schema as the server,
// which re-validates. On success the action opens the new request.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, Plus } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";

import { createManualAccessRequestAction } from "@/app/admin/access-requests/actions";
import { COUNTRIES } from "@/components/site/request-access/countries";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import {
  manualAccessRequestSchema,
  MAX_COMPANY_LENGTH,
  MAX_COUNTRY_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
} from "@/lib/schemas/access-request";

import { callAction, type ServiceErrors } from "../action-result";

type ManualValues = z.input<typeof manualAccessRequestSchema>;
type ManualParsed = z.output<typeof manualAccessRequestSchema>;

const EMPTY: ManualValues = {
  name: "",
  email: "",
  company: "",
  country: "",
  phone: "",
  message: "",
  kind: "new",
};

const TEXT_FIELDS = [
  "name",
  "email",
  "company",
  "country",
  "phone",
  "message",
] as const;
type FieldName = (typeof TEXT_FIELDS)[number];
const isFieldName = (key: string): key is FieldName =>
  (TEXT_FIELDS as readonly string[]).includes(key);

/* Field errors under their inputs (focus on the first), the rest above. */
function applyServerErrors(
  form: Pick<UseFormReturn<ManualValues, unknown, ManualParsed>, "setError">,
  errors: ServiceErrors,
): string[] {
  const messages = [...errors.formErrors];
  let focused = false;
  for (const [key, list] of Object.entries(errors.fieldErrors)) {
    const message = list[0];
    if (message === undefined) continue;
    if (isFieldName(key)) {
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

export function ManualRequestDialog() {
  const [open, setOpen] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<boolean | "unknown">(false);
  const [pending, startTransition] = useTransition();
  // Set synchronously: `pending` only turns true on a later render.
  const inFlight = useRef(false);
  const form = useForm<ManualValues, unknown, ManualParsed>({
    resolver: zodResolver(manualAccessRequestSchema),
    defaultValues: EMPTY,
  });

  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setFormErrors([]);
    // The raw strings go to the server, which parses the same schema.
    const values = form.getValues();
    startTransition(async () => {
      // On success the action redirects to the new request.
      const result = await callAction(() =>
        createManualAccessRequestAction(values),
      );
      if (!result || result.ok) return;
      inFlight.current = false;
      setSaved(result.saved);
      setFormErrors(applyServerErrors(form, result.errors));
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  const text = (
    name: Exclude<FieldName, "message">,
    label: string,
    options: {
      type?: string;
      maxLength: number;
      autoComplete?: string;
      required?: boolean;
      list?: string;
      help?: string;
    },
  ) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => {
        const id = `manual-${name}`;
        const describedBy = [
          options.help ? `${id}-help` : null,
          fieldState.invalid ? `${id}-error` : null,
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={id}>
              {label}
              {options.required ? null : (
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              )}
            </FieldLabel>
            <Input
              {...field}
              name={undefined}
              id={id}
              type={options.type ?? "text"}
              autoComplete={options.autoComplete ?? "off"}
              maxLength={options.maxLength}
              list={options.list}
              required={options.required}
              aria-invalid={fieldState.invalid}
              aria-describedby={describedBy || undefined}
            />
            {options.help ? (
              <FieldDescription id={`${id}-help`}>
                {options.help}
              </FieldDescription>
            ) : null}
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
        setOpen(next);
        if (next) {
          form.reset(EMPTY);
          setFormErrors([]);
          setSaved(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <Plus data-icon="inline-start" aria-hidden="true" />
          Add WhatsApp request
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <form
          noValidate
          aria-busy={pending}
          onSubmit={onSubmit}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Add a WhatsApp request</DialogTitle>
            <DialogDescription>
              For someone who asked for datasheet access on WhatsApp. The
              request joins the pending list, where you approve or reject it.
            </DialogDescription>
          </DialogHeader>

          {formErrors.length > 0 ? (
            <Alert variant="destructive" role="alert">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>
                {saved === true
                  ? "Added, with a problem"
                  : saved === "unknown"
                    ? "The request could not be confirmed"
                    : "The request was not added"}
              </AlertTitle>
              <AlertDescription>{formErrors.join(" ")}</AlertDescription>
            </Alert>
          ) : null}

          <FieldGroup>
            {text("name", "Name", {
              maxLength: MAX_NAME_LENGTH,
              required: true,
            })}
            {text("email", "Email", {
              type: "email",
              maxLength: 254,
              required: true,
              help: "The invite link is sent to this address.",
            })}
            {text("company", "Company", { maxLength: MAX_COMPANY_LENGTH })}
            {text("country", "Country", {
              maxLength: MAX_COUNTRY_LENGTH,
              list: "manual-country-options",
            })}
            {text("phone", "Phone", { type: "tel", maxLength: 40 })}

            <Controller
              name="kind"
              control={form.control}
              render={({ field }) => (
                <FieldSet>
                  <FieldLegend variant="label">Type</FieldLegend>
                  <RadioGroup
                    value={field.value ?? "new"}
                    onValueChange={field.onChange}
                    className="flex flex-wrap gap-4"
                  >
                    <Field orientation="horizontal" className="w-auto">
                      <RadioGroupItem value="new" id="manual-kind-new" />
                      <FieldLabel
                        htmlFor="manual-kind-new"
                        className="font-normal"
                      >
                        New access
                      </FieldLabel>
                    </Field>
                    <Field orientation="horizontal" className="w-auto">
                      <RadioGroupItem
                        value="renewal"
                        id="manual-kind-renewal"
                      />
                      <FieldLabel
                        htmlFor="manual-kind-renewal"
                        className="font-normal"
                      >
                        Renewal
                      </FieldLabel>
                    </Field>
                  </RadioGroup>
                </FieldSet>
              )}
            />

            <Controller
              name="message"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="manual-message">
                    Note
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </FieldLabel>
                  <Textarea
                    {...field}
                    name={undefined}
                    id="manual-message"
                    rows={3}
                    maxLength={MAX_MESSAGE_LENGTH}
                    aria-invalid={fieldState.invalid}
                    aria-describedby={
                      fieldState.invalid ? "manual-message-error" : undefined
                    }
                  />
                  <FieldError
                    id="manual-message-error"
                    errors={[fieldState.error]}
                  />
                </Field>
              )}
            />
          </FieldGroup>
          <datalist id="manual-country-options">
            {COUNTRIES.map((country) => (
              <option key={country} value={country} />
            ))}
          </datalist>

          <DialogFooter>
            <Button type="submit" disabled={pending || saved !== false}>
              {pending ? "Adding…" : "Add request"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
