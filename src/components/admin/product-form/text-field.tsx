// One labelled text input (or textarea) of the product edit form, bound to
// React Hook Form through the form context: help text and the error message
// are tied to the control with aria-describedby, invalid state with aria-invalid.

import type { ReactNode } from "react";
import { Controller, useFormContext } from "react-hook-form";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { SpecKey } from "@/models/spec-columns";

import type { FilterKey, ProductEditValues } from "./form-values";

/** The form fields that hold one string. */
export type TextFieldName =
  | "name"
  | "slug"
  | "family"
  | "modelCode"
  | "productNo"
  | "type"
  | "description"
  | `filters.${FilterKey}`
  | `specs.${SpecKey}`
  | `variants.${number}.${"modelNo" | "label"}`
  | `variants.${number}.specs.${SpecKey}`
  | `extraSpecs.${number}.${"group" | "label" | "value"}`
  | `publicFiles.${number}.${"label" | "url"}`;

/** The DOM id for a field, e.g. `filters.cctK` -> `product-filters-cctK`. */
export function fieldId(name: string): string {
  return `product-${name.replaceAll(".", "-")}`;
}

/** aria-describedby for a control: its help text, plus the error when shown. */
export function describedBy(
  id: string,
  { help, invalid }: { help: boolean; invalid: boolean },
): string | undefined {
  const ids = [help ? `${id}-help` : "", invalid ? `${id}-error` : ""].filter(
    (part) => part !== "",
  );
  return ids.length > 0 ? ids.join(" ") : undefined;
}

export function TextField({
  name,
  label,
  labelExtra,
  help,
  maxLength,
  multiline = false,
  rows = 5,
  inputMode,
  spellCheck,
  required = false,
}: {
  name: TextFieldName;
  label: string;
  /** Shown after the label inside it, e.g. a "Restricted" badge. */
  labelExtra?: ReactNode;
  help?: string;
  maxLength?: number;
  multiline?: boolean;
  /** Starting height of a textarea (it grows with its content). */
  rows?: number;
  inputMode?: "text" | "numeric" | "decimal" | "url";
  spellCheck?: boolean;
  required?: boolean;
}) {
  const { control } = useFormContext<ProductEditValues>();
  const id = fieldId(name);
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => {
        const props = {
          ...field,
          /*
           * No name attribute: a Save clicked before hydration makes the
           * browser submit the form natively (a GET), and named inputs would
           * put every value, restricted specs included, into the URL.
           */
          name: undefined,
          // A variant's spec difference can be removed while mounted.
          value: field.value ?? "",
          id,
          maxLength,
          spellCheck,
          required,
          autoComplete: "off",
          "aria-invalid": fieldState.invalid,
          "aria-describedby": describedBy(id, {
            help: help !== undefined,
            invalid: fieldState.invalid,
          }),
        };
        return (
          <Field data-invalid={fieldState.invalid}>
            <FieldLabel htmlFor={id}>
              {label}
              {labelExtra ? <> {labelExtra}</> : null}
            </FieldLabel>
            {multiline ? (
              <Textarea
                {...props}
                rows={rows}
                // Short spec texts start one line high and grow as they fill.
                className={rows <= 2 ? "min-h-9" : undefined}
              />
            ) : (
              <Input {...props} inputMode={inputMode} />
            )}
            {help !== undefined ? (
              <FieldDescription id={`${id}-help`}>{help}</FieldDescription>
            ) : null}
            <FieldError id={`${id}-error`} errors={[fieldState.error]} />
          </Field>
        );
      }}
    />
  );
}
