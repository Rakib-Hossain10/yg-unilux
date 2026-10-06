// A read-only list of the product's variants (model no. and label) until the
// variants editor arrives (T10b). The variants are still sent back unchanged
// on every save, so this section only shows what is kept.

import { useFormContext, useWatch } from "react-hook-form";

import { FormSection } from "./form-section";
import type { ProductEditValues } from "./form-values";

export function VariantsSummary() {
  const { control } = useFormContext<ProductEditValues>();
  const variants = useWatch({ control, name: "variants" });
  return (
    <FormSection
      title={`Variants (${variants.length})`}
      description="Each model no. of this product, e.g. a lens and a reflector version."
    >
      {variants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No variants yet. A product needs at least one before it can be
          published.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {variants.map((variant, index) => (
            <li key={`${index}-${variant.modelNo}`}>
              <span className="font-medium">{variant.modelNo}</span>
              {variant.label ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {variant.label}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </FormSection>
  );
}
