// Section (a) of the product edit form, "Categories and areas": the main
// category, extra categories, areas (checkbox groups) and the Magnetic Track
// size, shown only when a chosen category is Magnetic Track (ADR 0041).

import { Controller, useFormContext } from "react-hook-form";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TRACK_SIZES } from "@/models/product-constants";

import { FormSection } from "./form-section";
import { NO_TRACK_SIZE, type ProductEditValues } from "./form-values";
import { describedBy, fieldId } from "./text-field";

/** One choice in a picker: an id and its label (e.g. "Spot Lights › Recessed"). */
export interface PickerOption {
  id: string;
  label: string;
}

/*
 * A group of checkboxes over a list of ids. The first ENABLED checkbox takes
 * the field's ref, so a server error can move focus into the group (a
 * disabled one, e.g. the main category, can't take focus).
 */
function CheckboxGroupField({
  name,
  legend,
  help,
  options,
  disabledIds,
  disabledNote,
  empty,
}: {
  name: "extraCategories" | "areas";
  legend: string;
  help: string;
  options: PickerOption[];
  disabledIds?: ReadonlySet<string>;
  disabledNote?: string;
  empty: string;
}) {
  const { control } = useFormContext<ProductEditValues>();
  const id = fieldId(name);
  return (
    <Controller
      name={name}
      control={control}
      render={({ field, fieldState }) => {
        const chosen = new Set(field.value);
        const focusId = options.find(
          (option) => !(disabledIds?.has(option.id) ?? false),
        )?.id;
        const toggle = (optionId: string, on: boolean) => {
          field.onChange(
            on
              ? [...field.value, optionId]
              : field.value.filter((value) => value !== optionId),
          );
        };
        return (
          <FieldSet
            data-invalid={fieldState.invalid}
            aria-describedby={describedBy(id, {
              help: true,
              invalid: fieldState.invalid,
            })}
          >
            <FieldLegend variant="label">{legend}</FieldLegend>
            <FieldDescription id={`${id}-help`}>{help}</FieldDescription>
            {options.length === 0 ? (
              <p className="text-sm text-muted-foreground">{empty}</p>
            ) : (
              <div
                data-slot="checkbox-group"
                className="grid gap-3 sm:grid-cols-2"
              >
                {options.map((option) => {
                  const optionId = `${id}-${option.id}`;
                  const disabled = disabledIds?.has(option.id) ?? false;
                  return (
                    <Field
                      key={option.id}
                      orientation="horizontal"
                      data-disabled={disabled || undefined}
                    >
                      <Checkbox
                        id={optionId}
                        ref={option.id === focusId ? field.ref : undefined}
                        checked={!disabled && chosen.has(option.id)}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          toggle(option.id, checked === true)
                        }
                        onBlur={field.onBlur}
                        aria-invalid={fieldState.invalid}
                      />
                      <FieldLabel htmlFor={optionId} className="font-normal">
                        {option.label}
                        {disabled && disabledNote ? (
                          <span className="text-muted-foreground">
                            {" "}
                            ({disabledNote})
                          </span>
                        ) : null}
                      </FieldLabel>
                    </Field>
                  );
                })}
              </div>
            )}
            <FieldError id={`${id}-error`} errors={[fieldState.error]} />
          </FieldSet>
        );
      }}
    />
  );
}

export function CategoriesSection({
  categories,
  areas,
  showTrackSize,
}: {
  categories: PickerOption[];
  areas: PickerOption[];
  showTrackSize: boolean;
}) {
  const { control, getValues, setValue, watch } =
    useFormContext<ProductEditValues>();
  const mainCategory = watch("mainCategory");
  const mainId = fieldId("mainCategory");
  const trackId = fieldId("trackSize");

  return (
    <FormSection
      title="Categories and areas"
      description="Where the product is listed. The same product can appear in several categories and areas."
    >
      <FieldGroup>
        <Controller
          name="mainCategory"
          control={control}
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={mainId}>Main category</FieldLabel>
              <Select
                name={field.name}
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  // The service refuses the main category as an extra one.
                  const extras = getValues("extraCategories");
                  if (extras.includes(value)) {
                    setValue(
                      "extraCategories",
                      extras.filter((id) => id !== value),
                      { shouldDirty: true },
                    );
                  }
                }}
              >
                <SelectTrigger
                  id={mainId}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  className="w-full sm:w-96"
                  aria-invalid={fieldState.invalid}
                  aria-describedby={describedBy(mainId, {
                    help: true,
                    invalid: fieldState.invalid,
                  })}
                >
                  <SelectValue placeholder="Choose a category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription id={`${mainId}-help`}>
                Where the product is listed first, and its breadcrumb.
              </FieldDescription>
              <FieldError id={`${mainId}-error`} errors={[fieldState.error]} />
            </Field>
          )}
        />

        <CheckboxGroupField
          name="extraCategories"
          legend="Extra categories (optional)"
          help="The product is also listed under these, e.g. Recessed Lights › Spot."
          options={categories}
          disabledIds={new Set([mainCategory])}
          disabledNote="main category"
          empty="No categories yet."
        />

        {showTrackSize ? (
          <Controller
            name="trackSize"
            control={control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={trackId}>Track size</FieldLabel>
                <Select
                  name={field.name}
                  value={field.value}
                  onValueChange={field.onChange}
                >
                  <SelectTrigger
                    id={trackId}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    className="w-full sm:w-48"
                    aria-invalid={fieldState.invalid}
                    aria-describedby={describedBy(trackId, {
                      help: true,
                      invalid: fieldState.invalid,
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NO_TRACK_SIZE}>None</SelectItem>
                      {TRACK_SIZES.map((size) => (
                        <SelectItem key={size} value={String(size)}>
                          {size} mm
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription id={`${trackId}-help`}>
                  Magnetic Track products only. Visitors can filter the listing
                  by it.
                </FieldDescription>
                <FieldError
                  id={`${trackId}-error`}
                  errors={[fieldState.error]}
                />
              </Field>
            )}
          />
        ) : null}

        <CheckboxGroupField
          name="areas"
          legend="Areas (optional)"
          help="The applications this product suits, e.g. Retail, Office."
          options={areas}
          empty="No areas yet. Add them under Areas."
        />
      </FieldGroup>
    </FormSection>
  );
}
