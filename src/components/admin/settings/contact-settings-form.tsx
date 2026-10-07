"use client";

// WhatsApp number and company email: two small forms, each saved on its own.
// Same Zod schemas as the server (ADR 0049); empty clears the value.

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import {
  saveCompanyEmailAction,
  saveWhatsappNumberAction,
} from "@/app/admin/settings/actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  companyEmailSchema,
  whatsappNumberSchema,
} from "@/lib/schemas/settings";

import { allMessages, callAction, type ActionResult } from "../action-result";

interface SingleSettingProps {
  id: string;
  label: string;
  help: string;
  buttonLabel: string;
  placeholder: string;
  type: "tel" | "email";
  autoComplete: string;
  initial: string;
  schema: typeof whatsappNumberSchema | typeof companyEmailSchema;
  save: (input: unknown) => Promise<ActionResult>;
}

function SingleSettingForm(props: SingleSettingProps) {
  const { id, schema } = props;
  const form = useForm<{ value: string }, unknown, { value: string | null }>({
    resolver: zodResolver(z.object({ value: schema })),
    defaultValues: { value: props.initial },
  });
  const [baseline, setBaseline] = useState(props.initial);
  const [saved, setSaved] = useState(false);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const inFlight = useRef(false);

  const value = useWatch({ control: form.control, name: "value" });
  const changed = value.trim() !== baseline;

  const submitValid = () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaved(false);
    setFormErrors([]);
    const raw = form.getValues("value");
    startTransition(async () => {
      const result = await callAction(() => props.save(raw));
      inFlight.current = false;
      if (!result) return;
      if (result.ok) {
        setBaseline(raw.trim());
        setSaved(true);
        return;
      }
      const messages = allMessages(result.errors);
      const first = messages[0];
      if (result.saved === false && first !== undefined) {
        form.setError("value", { type: "server", message: first });
      } else {
        setFormErrors(messages);
      }
    });
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      aria-busy={pending}
      className="flex flex-col gap-4"
    >
      {formErrors.length > 0 ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>The change could not be confirmed</AlertTitle>
          <AlertDescription>
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {formErrors.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {saved ? (
        <Alert role="status">
          <CircleCheck aria-hidden="true" />
          <AlertTitle>{props.label} saved.</AlertTitle>
        </Alert>
      ) : null}

      <FieldGroup>
        <Controller
          name="value"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={id}>{props.label}</FieldLabel>
              <Input
                {...field}
                // No name: a submit before hydration would put it in the URL.
                name={undefined}
                id={id}
                type={props.type}
                autoComplete={props.autoComplete}
                placeholder={props.placeholder}
                maxLength={254}
                spellCheck={false}
                aria-invalid={fieldState.invalid}
                aria-describedby={`${id}-help${fieldState.invalid ? ` ${id}-error` : ""}`}
                onChange={(event) => {
                  setSaved(false);
                  field.onChange(event);
                }}
              />
              <FieldDescription id={`${id}-help`}>
                {props.help}
              </FieldDescription>
              <FieldError id={`${id}-error`} errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>

      <div>
        <Button type="submit" disabled={pending || !changed}>
          {pending ? "Saving…" : props.buttonLabel}
        </Button>
      </div>
    </form>
  );
}

export function ContactSettingsForm({
  whatsappNumber,
  companyEmail,
}: {
  whatsappNumber: string | null;
  companyEmail: string | null;
}) {
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Contact details</CardTitle>
        <CardDescription>
          Shown to visitors who want to reach the company. Save each one on its
          own.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-8">
        <SingleSettingForm
          id="settings-whatsapp"
          label="WhatsApp number"
          help="With the country code, e.g. +852 1234 5678. Leave empty to remove it."
          buttonLabel="Save WhatsApp number"
          placeholder="+852 1234 5678"
          type="tel"
          autoComplete="off"
          initial={whatsappNumber ? `+${whatsappNumber}` : ""}
          schema={whatsappNumberSchema}
          save={saveWhatsappNumberAction}
        />
        <SingleSettingForm
          id="settings-company-email"
          label="Company email"
          help="Where enquiries and named whistleblower reports go. Leave empty to use the address set in the server configuration."
          buttonLabel="Save company email"
          placeholder="info@example.com"
          type="email"
          autoComplete="off"
          initial={companyEmail ?? ""}
          schema={companyEmailSchema}
          save={saveCompanyEmailAction}
        />
      </CardContent>
    </Card>
  );
}
