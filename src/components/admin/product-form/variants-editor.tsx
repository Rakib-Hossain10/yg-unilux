// Section (b) of the product edit form, "Variants": one row per model no.
// (e.g. a lens and a reflector version) with its label, image public id and
// the specs that differ from the product's. Removing a row asks first.

import { X } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  MAX_MODEL_NO_LENGTH,
  MAX_PUBLIC_ID_LENGTH,
  MAX_VARIANT_LABEL_LENGTH,
  MAX_VARIANTS,
} from "@/lib/constants";
import { SPEC_KEYS, type SpecKey } from "@/models/spec-columns";

import type { ProductEditValues, SpecOverrideTexts } from "./form-values";
import { useFocusAfterRender } from "./row-controls";
import {
  RowListSection,
  type RemoveConfirm,
  type RowInputsProps,
} from "./row-list-section";
import { isRestrictedByDefault, SPEC_HEADER } from "./spec-groups";
import { RestrictedBadge, SPEC_TEXT_MAX_LENGTH } from "./specs-section";
import { fieldId, TextField } from "./text-field";

/*
 * A native <select>, not the Radix one: inside a form Radix renders a hidden
 * native select with every option anyway, and with up to 200 rows a plain
 * element is the lighter choice. Styled with the Input tokens.
 */
const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 py-1 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm";

/**
 * The spec values that differ for this variant: one input per added key, a
 * remove button per key, and a picker to add another key. Watches only this
 * row's `specs`, so other rows don't re-render.
 */
function SpecDifferences({ index, rowName }: RowInputsProps) {
  const { control, getValues, setValue } = useFormContext<ProductEditValues>();
  const specs: SpecOverrideTexts =
    useWatch({ control, name: `variants.${index}.specs` }) ?? {};
  const present = SPEC_KEYS.filter((key) => Object.hasOwn(specs, key));
  const available = SPEC_KEYS.filter((key) => !Object.hasOwn(specs, key));
  const [choice, setChoice] = useState<SpecKey | "">("");
  const focusLater = useFocusAfterRender();
  const pickerId = fieldId(`variants.${index}.specs.add`);
  const picked = choice !== "" && available.includes(choice) ? choice : "";

  const addKey = () => {
    if (picked === "") return;
    setValue(`variants.${index}.specs.${picked}`, "", { shouldDirty: true });
    setChoice("");
    focusLater(fieldId(`variants.${index}.specs.${picked}`));
  };

  const removeKey = (key: SpecKey) => {
    const rest = { ...getValues(`variants.${index}.specs`) };
    delete rest[key];
    setValue(`variants.${index}.specs`, rest, { shouldDirty: true });
    focusLater(pickerId);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">Specs that differ</p>
      {present.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None. This variant uses the product&apos;s specs.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {present.map((key) => (
            <li key={key} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  name={`variants.${index}.specs.${key}`}
                  label={SPEC_HEADER.get(key) ?? key}
                  labelExtra={
                    isRestrictedByDefault(key) ? <RestrictedBadge /> : null
                  }
                  multiline
                  rows={1}
                  maxLength={SPEC_TEXT_MAX_LENGTH}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="mt-6"
                aria-label={`Remove ${SPEC_HEADER.get(key) ?? key} from ${rowName}`}
                onClick={() => removeKey(key)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="w-auto min-w-48">
            <FieldLabel htmlFor={pickerId}>Add a spec that differs</FieldLabel>
            <select
              id={pickerId}
              className={SELECT_CLASS}
              value={picked}
              onChange={(event) =>
                setChoice(event.target.value as SpecKey | "")
              }
            >
              <option value="">Choose a spec…</option>
              {available.map((key) => (
                <option key={key} value={key}>
                  {SPEC_HEADER.get(key) ?? key}
                </option>
              ))}
            </select>
          </Field>
          <Button
            type="button"
            variant="outline"
            aria-disabled={picked === ""}
            aria-label={`Add the chosen spec to ${rowName}`}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={addKey}
          >
            Add
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/* The inputs of one variant row. */
const VariantInputs = memo(function VariantInputs({
  index,
  rowName,
}: RowInputsProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-3">
        <TextField
          name={`variants.${index}.modelNo`}
          label="Model no."
          required
          spellCheck={false}
          maxLength={MAX_MODEL_NO_LENGTH}
        />
        <TextField
          name={`variants.${index}.label`}
          label="Label (optional)"
          maxLength={MAX_VARIANT_LABEL_LENGTH}
        />
        <TextField
          name={`variants.${index}.imagePublicId`}
          label="Image public id (optional)"
          spellCheck={false}
          maxLength={MAX_PUBLIC_ID_LENGTH}
        />
      </div>
      <SpecDifferences index={index} rowName={rowName} />
    </div>
  );
});

/* Memoised: no props, so form-level re-renders skip the rows. */
export const VariantsEditor = memo(function VariantsEditor() {
  const { getValues } = useFormContext<ProductEditValues>();
  // Read when the dialog opens, so it names the row's current model no.
  // Stable, so the memoised rows keep their callbacks.
  const confirmRemove = useCallback(
    (index: number): RemoveConfirm => {
      const modelNo = getValues(`variants.${index}.modelNo`).trim();
      return {
        title: `Remove variant ${index + 1}?`,
        description: `${modelNo === "" ? "This variant" : modelNo} and the specs that differ for it are removed from the product when you save. Until then, leaving the page without saving keeps it.`,
      };
    },
    [getValues],
  );
  return (
    <RowListSection
      name="variants"
      title="Variants"
      description="Each model no. of this product, e.g. a lens and a reflector version. The label is shown on the optic switch. Under each variant, add only the specs that differ from the product's. A product needs at least one variant before it can be published."
      noun="variant"
      addLabel="Add variant"
      emptyText="No variants yet. A product needs at least one before it can be published."
      max={MAX_VARIANTS}
      firstInput="modelNo"
      Inputs={VariantInputs}
      confirmRemove={confirmRemove}
    />
  );
});
