// One labelled text input (or textarea) of the product edit form, bound to
// React Hook Form through the form context: help text and the error message
// are tied to the control with aria-describedby, invalid state with aria-invalid.

import { Controller, useFormContext } from "react-hook-form";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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
  | `filters.${FilterKey}`;

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
  help,
  maxLength,
  multiline = false,
  inputMode,
  spellCheck,
  required = false,
}: {
  name: TextFieldName;
  label: string;
  help?: string;
  maxLength?: number;
  multiline?: boolean;
  inputMode?: "text" | "numeric" | "decimal";
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
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            {multiline ? (
              <Textarea {...props} rows={5} />
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
