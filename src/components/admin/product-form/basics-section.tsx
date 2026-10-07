// Section (a) of the product edit form, "Basics": name, slug, family, model
// code, the sheet's NO., type and description. Text inputs only; the server
// re-checks every value with productInputSchema.

import { FieldGroup } from "@/components/ui/field";
import {
  MAX_PRODUCT_DESCRIPTION_LENGTH,
  MAX_PRODUCT_FAMILY_LENGTH,
  MAX_PRODUCT_MODEL_CODE_LENGTH,
  MAX_PRODUCT_NAME_LENGTH,
  MAX_PRODUCT_TYPE_LENGTH,
} from "@/lib/constants";
import { MAX_SLUG_LENGTH } from "@/lib/slug";
import type { ProductStatus } from "@/models/product-constants";

import { FormSection } from "./form-section";
import { TextField } from "./text-field";

export function BasicsSection({ status }: { status: ProductStatus }) {
  return (
    <FormSection
      title="Basics"
      description="What the product is called and where it sits in its family."
    >
      <FieldGroup>
        <TextField
          name="name"
          label="Name"
          required
          maxLength={MAX_PRODUCT_NAME_LENGTH}
          help="Shown on the product page, e.g. Arc AR-013A."
        />
        <TextField
          name="slug"
          label="Slug"
          spellCheck={false}
          maxLength={MAX_SLUG_LENGTH}
          help={
            status === "published"
              ? "Part of the web address. This product is published: changing the slug changes its URL and breaks old links. Leave blank to keep the current one."
              : "Part of the web address, e.g. arc-ar-013a. Leave blank to keep the current one."
          }
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            name="family"
            label="Family (optional)"
            maxLength={MAX_PRODUCT_FAMILY_LENGTH}
            help="The sheet's Model Name, e.g. Arc. Products of one family are shown together."
          />
          <TextField
            name="modelCode"
            label="Model code (optional)"
            spellCheck={false}
            maxLength={MAX_PRODUCT_MODEL_CODE_LENGTH}
            help="The base model code, e.g. AR-013A."
          />
          <TextField
            name="productNo"
            label="Product no. (optional)"
            inputMode="numeric"
            help="The sheet's NO. column, e.g. 76."
          />
          <TextField
            name="type"
            label="Type (optional)"
            maxLength={MAX_PRODUCT_TYPE_LENGTH}
            help="The sheet's Model Type, e.g. Recessed spot."
          />
        </div>
        <TextField
          name="description"
          label="Description (optional)"
          multiline
          maxLength={MAX_PRODUCT_DESCRIPTION_LENGTH}
        />
      </FieldGroup>
    </FormSection>
  );
}
