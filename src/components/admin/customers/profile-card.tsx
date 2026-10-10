"use client";

// Profile card on the customer page: name, company and country. The email is
// the sign-in name and is not editable. Same Zod schema as the server, which
// re-validates the raw values.

import { zodResolver } from "@hookform/resolvers/zod";
import type { FormEvent } from "react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";

import { updateCustomerProfileAction } from "@/app/admin/customers/actions";
import { COUNTRIES } from "@/components/site/request-access/countries";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  MAX_COMPANY_LENGTH,
  MAX_COUNTRY_LENGTH,
  MAX_NAME_LENGTH,
} from "@/lib/schemas/access-request";
import { updateCustomerProfileSchema } from "@/lib/schemas/customer";

import { ActionFeedback } from "./action-feedback";
import { useCustomerAction } from "./use-customer-action";

type ProfileValues = z.input<typeof updateCustomerProfileSchema>;
type ProfileParsed = z.output<typeof updateCustomerProfileSchema>;

const FIELDS = ["name", "company", "country"] as const;
type ProfileField = (typeof FIELDS)[number];
const isProfileField = (key: string): key is ProfileField =>
  (FIELDS as readonly string[]).includes(key);

export function ProfileCard({
  customer,
}: {
  customer: {
    id: string;
    name: string;
    email: string;
    company: string | null;
    country: string | null;
  };
}) {
  const form = useForm<ProfileValues, unknown, ProfileParsed>({
    resolver: zodResolver(updateCustomerProfileSchema),
    defaultValues: {
      userId: customer.id,
      name: customer.name,
      company: customer.company ?? "",
      country: customer.country ?? "",
    },
  });
  const save = useCustomerAction();

  const submitValid = () => {
    // Raw values: the parsed output would not parse again ("" → null).
    const values = form.getValues();
    save.run(
      () => updateCustomerProfileAction(values),
      "Profile saved.",
      (fieldErrors) => {
        let any = false;
        for (const [key, list] of Object.entries(fieldErrors)) {
          const message = list[0];
          if (message !== undefined && isProfileField(key)) {
            form.setError(key, { type: "server", message });
            any = true;
          }
        }
        return any;
      },
    );
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    form.handleSubmit(submitValid)(event);

  const input = (name: ProfileField, label: string, maxLength: number) => (
    <Controller
      name={name}
      control={form.control}
      render={({ field, fieldState }) => {
        const id = `profile-${name}`;
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={id}>
              {label}
              {name === "name" ? null : (
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              )}
            </FieldLabel>
            <Input
              {...field}
              value={field.value ?? ""}
              name={undefined}
              id={id}
              autoComplete="off"
              maxLength={maxLength}
              list={name === "country" ? "profile-country-options" : undefined}
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
    <Card>
      <form noValidate aria-busy={save.pending} onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>
            <h2>Profile</h2>
          </CardTitle>
          <CardDescription>
            Signs in as <span className="break-all">{customer.email}</span>. The
            email can&apos;t be changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 py-4">
          <FieldGroup>
            {input("name", "Name", MAX_NAME_LENGTH)}
            {input("company", "Company", MAX_COMPANY_LENGTH)}
            {input("country", "Country", MAX_COUNTRY_LENGTH)}
            <datalist id="profile-country-options">
              {COUNTRIES.map((country) => (
                <option key={country} value={country} />
              ))}
            </datalist>
          </FieldGroup>
          <ActionFeedback
            status={save.status}
            errors={save.errors}
            saved={save.saved}
            failedTitle="The profile was not saved"
          />
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={save.pending}>
            {save.pending ? "Saving…" : "Save profile"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
