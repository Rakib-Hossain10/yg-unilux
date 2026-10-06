// Section (a) of the product edit form, "Filters": the numbers behind the
// public listing filters (CCT, CRI, beam angle, UGR, wattage, IP), typed as
// comma-separated lists and stored as numbers next to the display specs.
// Plain text keyboards: a decimal keypad has no comma or space for a list.

import { FieldGroup } from "@/components/ui/field";

import { FormSection } from "./form-section";
import { FILTER_FIELDS } from "./form-values";
import { TextField } from "./text-field";

export function FiltersSection() {
  return (
    <FormSection
      title="Filters"
      description="Numbers only, separated by commas. Visitors filter the product listings by these. Leave blank when a filter does not apply."
    >
      <FieldGroup>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FILTER_FIELDS.map((filter) => (
            <TextField
              key={filter.key}
              name={`filters.${filter.key}`}
              label={filter.label}
              spellCheck={false}
              help={`e.g. ${filter.example}`}
            />
          ))}
        </div>
      </FieldGroup>
    </FormSection>
  );
}
