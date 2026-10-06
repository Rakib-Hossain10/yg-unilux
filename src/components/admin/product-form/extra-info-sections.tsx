// Section (b) of the product edit form, "Extra specs" ({group, label, value}
// rows outside the sheet) and "Public files" (label + https:// link rows).
// Both are always public; the server re-checks every link (https only).

import { memo } from "react";

import {
  MAX_EXTRA_SPEC_GROUP_LENGTH,
  MAX_EXTRA_SPEC_LABEL_LENGTH,
  MAX_EXTRA_SPEC_VALUE_LENGTH,
  MAX_EXTRA_SPECS,
  MAX_PUBLIC_FILE_LABEL_LENGTH,
  MAX_PUBLIC_FILE_URL_LENGTH,
  MAX_PUBLIC_FILES,
} from "@/lib/constants";

import { RowListSection, type RowInputsProps } from "./row-list-section";
import { TextField } from "./text-field";

/* One extra spec row: group (optional), label, value. */
const ExtraSpecInputs = memo(function ExtraSpecInputs({
  index,
}: RowInputsProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      <TextField
        name={`extraSpecs.${index}.group`}
        label="Group (optional)"
        maxLength={MAX_EXTRA_SPEC_GROUP_LENGTH}
      />
      <TextField
        name={`extraSpecs.${index}.label`}
        label="Label"
        required
        maxLength={MAX_EXTRA_SPEC_LABEL_LENGTH}
      />
      <TextField
        name={`extraSpecs.${index}.value`}
        label="Value"
        required
        maxLength={MAX_EXTRA_SPEC_VALUE_LENGTH}
      />
    </div>
  );
});

/* One public file row: label and link. */
const PublicFileInputs = memo(function PublicFileInputs({
  index,
}: RowInputsProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-[1fr_2fr]">
      <TextField
        name={`publicFiles.${index}.label`}
        label="Label"
        required
        maxLength={MAX_PUBLIC_FILE_LABEL_LENGTH}
      />
      <TextField
        name={`publicFiles.${index}.url`}
        label="Link"
        required
        inputMode="url"
        spellCheck={false}
        maxLength={MAX_PUBLIC_FILE_URL_LENGTH}
      />
    </div>
  );
});

export const ExtraSpecsSection = memo(function ExtraSpecsSection() {
  return (
    <RowListSection
      name="extraSpecs"
      title="Extra specs"
      description="Information that is not in the spec sheet, e.g. Weight: 0.4 kg. Rows with the same group are shown together. Always public."
      noun="extra spec"
      addLabel="Add extra spec"
      emptyText="No extra specs."
      max={MAX_EXTRA_SPECS}
      firstInput="group"
      Inputs={ExtraSpecInputs}
    />
  );
});

export const PublicFilesSection = memo(function PublicFilesSection() {
  return (
    <RowListSection
      name="publicFiles"
      title="Public files"
      description="Links anyone may download, e.g. an IES file or installation guide. Full https:// links only. Restricted datasheets are not added here."
      noun="public file"
      addLabel="Add public file"
      emptyText="No public files."
      max={MAX_PUBLIC_FILES}
      firstInput="label"
      Inputs={PublicFileInputs}
    />
  );
});
