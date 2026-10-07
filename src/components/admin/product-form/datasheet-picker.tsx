// Section of the product edit form, "Datasheet": attach one stored Excel file
// or none. Saved with the form's Save button (datasheetId). One file can be
// attached to many products; uploading and deleting files is on the
// Datasheets page. A native select, because the list can be long.

import Link from "next/link";
import { Controller, useFormContext } from "react-hook-form";

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";

import { DATASHEETS_PATH } from "../datasheet-paths";
import { NATIVE_SELECT_CLASS } from "../native-select";
import type { PickerOption } from "./categories-section";
import { FormSection } from "./form-section";
import type { ProductEditValues } from "./form-values";
import { describedBy, fieldId } from "./text-field";

/** The select's value for "no datasheet" (an id is never empty). */
export const NO_DATASHEET = "";

export function DatasheetPicker({
  datasheets,
}: {
  datasheets: PickerOption[];
}) {
  const { control, clearErrors } = useFormContext<ProductEditValues>();
  const id = fieldId("datasheetId");

  return (
    <FormSection
      title="Datasheet"
      description="The Excel file approved customers can download from this product's page."
    >
      <Controller
        name="datasheetId"
        control={control}
        render={({ field, fieldState }) => {
          const value = field.value ?? NO_DATASHEET;
          // A stored id whose file was deleted meanwhile stays visible, so
          // the admin sees why publishing is refused and can detach it.
          const missing =
            value !== NO_DATASHEET &&
            !datasheets.some((option) => option.id === value);
          return (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={id}>Attached datasheet</FieldLabel>
              <select
                id={id}
                name={field.name}
                ref={field.ref}
                value={value}
                onBlur={field.onBlur}
                onChange={(event) => {
                  field.onChange(
                    event.target.value === NO_DATASHEET
                      ? null
                      : event.target.value,
                  );
                  // A publish refusal about the old choice no longer applies.
                  clearErrors("datasheetId");
                }}
                aria-invalid={fieldState.invalid}
                aria-describedby={describedBy(id, {
                  help: true,
                  invalid: fieldState.invalid,
                })}
                className={NATIVE_SELECT_CLASS}
              >
                <option value={NO_DATASHEET}>
                  None (the page shows &quot;Datasheet coming soon&quot;)
                </option>
                {missing ? (
                  <option value={value}>
                    This datasheet no longer exists. Choose another or none.
                  </option>
                ) : null}
                {datasheets.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <FieldDescription id={`${id}-help`}>
                {datasheets.length === 0 ? (
                  <>
                    No datasheets uploaded yet.{" "}
                    <Link href={DATASHEETS_PATH} className="underline">
                      Upload one
                    </Link>
                    .
                  </>
                ) : (
                  <>
                    One file can be attached to many products.{" "}
                    <Link href={DATASHEETS_PATH} className="underline">
                      Manage datasheets
                    </Link>
                    . Save the product to apply the change.
                  </>
                )}
              </FieldDescription>
              <FieldError id={`${id}-error`} errors={[fieldState.error]} />
            </Field>
          );
        }}
      />
    </FormSection>
  );
}
