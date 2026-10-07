// Section (b) of the product edit form, "Specs": the product-level values of
// the 28 sheet spec columns, grouped as in the sheet. One option per line;
// columns restricted by default carry a plain "Restricted" badge.

import { memo } from "react";

import { Badge } from "@/components/ui/badge";
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field";
import { MAX_SPEC_OPTIONS, MAX_SPEC_VALUE_LENGTH } from "@/lib/constants";

import { FormSection } from "./form-section";
import { SPEC_GROUPS } from "./spec-groups";
import { TextField } from "./text-field";

/** The most a spec text can hold: every option at full length, one per line. */
export const SPEC_TEXT_MAX_LENGTH =
  MAX_SPEC_OPTIONS * (MAX_SPEC_VALUE_LENGTH + 1);

/**
 * The badge on a column that only approved customers see by default. It says
 * "by default" because the visibility setting (a later task) can change it.
 */
export function RestrictedBadge() {
  return <Badge variant="secondary">Restricted by default</Badge>;
}

/*
 * Memoised: it takes no props, so typing elsewhere in the form never
 * re-renders these 28 inputs (each Controller still re-renders itself).
 */
export const SpecsSection = memo(function SpecsSection() {
  return (
    <FormSection
      title="Specs"
      description="Values shared by every variant. Put each option on its own line (e.g. 3000K, then 4000K on the next line). Leave blank when a spec does not apply. Columns marked restricted by default are shown only to approved customers, unless the column visibility setting says otherwise."
    >
      <FieldGroup>
        {SPEC_GROUPS.map((group) => (
          <FieldSet key={group.title}>
            <FieldLegend>{group.title}</FieldLegend>
            <div className="grid gap-5 sm:grid-cols-2">
              {group.columns.map((column) => (
                <TextField
                  key={column.key}
                  name={`specs.${column.key}`}
                  label={column.header}
                  labelExtra={
                    column.restrictedByDefault ? <RestrictedBadge /> : null
                  }
                  multiline
                  rows={1}
                  maxLength={SPEC_TEXT_MAX_LENGTH}
                />
              ))}
            </div>
          </FieldSet>
        ))}
      </FieldGroup>
    </FormSection>
  );
});
