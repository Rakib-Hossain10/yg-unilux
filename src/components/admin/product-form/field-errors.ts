// Maps product validation errors onto the edit form: Zod issue paths from the
// client resolver and the server's fieldErrors keys (incl. the service's
// `variants.N.modelNo`) become form fields; the rest go to a form-level alert.

import type {
  FieldError,
  FieldErrors,
  Resolver,
  UseFormReturn,
} from "react-hook-form";

import type { ServiceErrors } from "@/components/admin/action-result";
import { productInputSchema } from "@/lib/schemas/product";
import { SPEC_COLUMNS } from "@/models/spec-columns";

import {
  FILTER_FIELDS,
  FILTER_KEYS,
  parseNumberList,
  parseProductNo,
  toProductInput,
  type ProductEditValues,
} from "./form-values";

/** Top-level fields that map 1:1 onto one form field. */
const SIMPLE_FIELDS = new Set([
  "name",
  "slug",
  "family",
  "modelCode",
  "productNo",
  "type",
  "description",
  "mainCategory",
  "trackSize",
  "datasheetId",
]);
/** List fields whose entries share one input group. */
const LIST_FIELDS = new Set(["extraCategories", "areas"]);
const SPEC_KEYS = new Set<string>(SPEC_COLUMNS.map((column) => column.key));
const ROW_FIELDS: Record<string, Set<string>> = {
  variants: new Set(["modelNo", "label", "imagePublicId"]),
  extraSpecs: new Set(["group", "label", "value"]),
  publicFiles: new Set(["label", "url"]),
};
const isIndex = (part: string | undefined) =>
  part !== undefined && /^\d+$/.test(part);

/**
 * The form field an error path belongs to, or null when no single field owns
 * it (`status`, a whole `filters` object, an unknown key). Paths may be
 * dotted strings (server) or Zod paths (client). Examples:
 * `areas.2` -> `areas`; `filters.cctK.0` -> `filters.cctK`;
 * `variants.3.modelNo` -> itself; `variants.1.specs.cct.0` ->
 * `variants.1.specs.cct`; `specs.cct.2` -> `specs.cct` (an option of a spec
 * belongs to that spec's input).
 */
export function formFieldForPath(
  path: string | readonly PropertyKey[],
): string | null {
  const parts = (
    typeof path === "string" ? path.split(".") : path.map(String)
  ).filter((part) => part !== "");
  const [head, second, third, fourth] = parts;
  if (head === undefined) return null;
  if (SIMPLE_FIELDS.has(head)) return parts.length === 1 ? head : null;
  if (LIST_FIELDS.has(head)) {
    return parts.length === 1 || (parts.length === 2 && isIndex(second))
      ? head
      : null;
  }
  if (head === "filters") {
    return (FILTER_KEYS as readonly string[]).includes(second ?? "") &&
      (parts.length === 2 || (parts.length === 3 && isIndex(third)))
      ? `filters.${second}`
      : null;
  }
  if (head === "specs") {
    return SPEC_KEYS.has(second ?? "") ? `specs.${second}` : null;
  }
  const rowFields = ROW_FIELDS[head];
  if (rowFields) {
    if (parts.length === 1) return head;
    if (!isIndex(second)) return null;
    if (parts.length === 2) return `${head}.${second}`;
    if (third !== undefined && rowFields.has(third) && parts.length === 3) {
      return `${head}.${second}.${third}`;
    }
    if (
      head === "variants" &&
      third === "specs" &&
      SPEC_KEYS.has(fourth ?? "")
    ) {
      return `variants.${second}.specs.${fourth}`;
    }
  }
  return null;
}

const ROW_NAMES: Record<string, string> = {
  variants: "Variant",
  extraSpecs: "Extra spec",
  publicFiles: "Public file",
};
const ROW_FIELD_NAMES: Record<string, string> = {
  modelNo: "model no.",
  label: "label",
  imagePublicId: "image",
  group: "group",
  value: "value",
  url: "link",
};
const FIELD_NAMES: Record<string, string> = {
  name: "Name",
  slug: "Slug",
  family: "Family",
  modelCode: "Model code",
  productNo: "Product no.",
  type: "Type",
  description: "Description",
  mainCategory: "Main category",
  extraCategories: "Extra categories",
  areas: "Areas",
  trackSize: "Track size",
  datasheetId: "Datasheet",
  specs: "Specs",
  filters: "Filters",
  variants: "Variants",
  extraSpecs: "Extra specs",
  publicFiles: "Public files",
  images: "Images",
};
const SPEC_HEADERS = new Map<string, string>(
  SPEC_COLUMNS.map((column) => [column.key, column.header]),
);
const FILTER_LABELS = new Map<string, string>(
  FILTER_FIELDS.map((field) => [field.key, field.label]),
);

/**
 * A short English name for a field, for the form-level alert, e.g.
 * "Variant 3, model no." (rows count from 1). "" when the message speaks for
 * itself (`status`, form-level).
 */
export function describeField(field: string): string {
  const [head = "", second, third, fourth] = field.split(".");
  if (head === "root" || head === "status" || head === "") return "";
  if (head === "filters" && second) {
    return `Filter ${FILTER_LABELS.get(second) ?? second}`;
  }
  if (head === "specs" && second) {
    return `Spec ${SPEC_HEADERS.get(second) ?? second}`;
  }
  const row = ROW_NAMES[head];
  if (row && isIndex(second)) {
    const name = `${row} ${Number(second) + 1}`;
    if (third === "specs" && fourth) {
      return `${name}, ${SPEC_HEADERS.get(fourth) ?? fourth}`;
    }
    return third ? `${name}, ${ROW_FIELD_NAMES[third] ?? third}` : name;
  }
  return FIELD_NAMES[head] ?? head;
}

/** One error message at one form field ("root" = the form as a whole). */
export interface FieldMessage {
  field: string;
  message: string;
}

/** "Label: message", or the message alone when the label is empty. */
export function labelled({ field, message }: FieldMessage): string {
  const label = describeField(field);
  return label === "" ? message : `${label}: ${message}`;
}

/**
 * Server errors -> messages per form field (first message of each key).
 * Keys no field owns are kept under "root" with their own label in front,
 * e.g. "Filters: At most 50 values"; form-level errors come first.
 */
export function serverFieldMessages(errors: ServiceErrors): FieldMessage[] {
  const messages: FieldMessage[] = errors.formErrors.map((message) => ({
    field: "root",
    message,
  }));
  for (const [key, list] of Object.entries(errors.fieldErrors)) {
    const message = list[0];
    if (message === undefined) continue;
    const field = formFieldForPath(key);
    if (field === null) {
      messages.push({
        field: "root",
        message: labelled({ field: key, message }),
      });
    } else {
      messages.push({ field, message });
    }
  }
  return messages;
}

/**
 * Splits messages into those shown under a rendered input and those that need
 * the alert above the form (labelled, without repeats). `rendered` says which
 * fields have an input on screen, so a `variants.2.modelNo` error before the
 * variants editor exists is still shown.
 */
export function splitMessages(
  messages: readonly FieldMessage[],
  rendered: (field: string) => boolean,
): { fields: FieldMessage[]; form: string[] } {
  const fields: FieldMessage[] = [];
  const form: string[] = [];
  const seen = new Set<string>();
  for (const entry of messages) {
    if (entry.field !== "root" && rendered(entry.field)) {
      if (!fields.some((f) => f.field === entry.field)) fields.push(entry);
      continue;
    }
    const text = labelled(entry);
    if (!seen.has(text)) {
      seen.add(text);
      form.push(text);
    }
  }
  return { fields, form };
}

/**
 * Puts server errors on the form: each rendered field gets its message (focus
 * on the first), the rest are returned for the alert. Exported for tests.
 */
export function applyServerErrors(
  form: Pick<UseFormReturn<ProductEditValues>, "setError">,
  errors: ServiceErrors,
  rendered: (field: string) => boolean,
): { formMessages: string[]; focusedField: boolean } {
  const { fields, form: formMessages } = splitMessages(
    serverFieldMessages(errors),
    rendered,
  );
  fields.forEach(({ field, message }, index) => {
    form.setError(
      // A path the form state has (checked by formFieldForPath).
      field as Parameters<typeof form.setError>[0],
      { type: "server", message },
      { shouldFocus: index === 0 },
    );
  });
  return { formMessages, focusedField: fields.length > 0 };
}

/** Every leaf error in React Hook Form's nested errors, with its path. */
export function flattenFormErrors(
  errors: FieldErrors | undefined,
  prefix = "",
): FieldMessage[] {
  if (!errors) return [];
  const out: FieldMessage[] = [];
  for (const [key, node] of Object.entries(errors)) {
    if (key === "ref" || node === null || typeof node !== "object") continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const message = (node as FieldError).message;
    if (typeof message === "string") {
      out.push({ field: path, message });
    } else {
      out.push(...flattenFormErrors(node as FieldErrors, path));
    }
  }
  return out;
}

/* Sets `value` at a dotted path, creating plain objects on the way. */
function setPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
) {
  const parts = path.split(".");
  let node = target;
  parts.slice(0, -1).forEach((part) => {
    const next = node[part];
    if (next === null || typeof next !== "object") node[part] = {};
    node = node[part] as Record<string, unknown>;
  });
  node[parts[parts.length - 1] ?? ""] = value;
}

/**
 * Checks the form on the client exactly as the server will: the text fields
 * the form parses itself (product no., filter numbers) first, then
 * productInputSchema on the converted input. Errors land on their form field;
 * an issue no field owns lands on "root". `magneticTrackIds` decides whether a
 * track size is sent at all.
 */
export function productEditResolver(
  magneticTrackIds: ReadonlySet<string>,
): Resolver<ProductEditValues> {
  return async (values) => {
    const messages: FieldMessage[] = [];
    const productNo = parseProductNo(values.productNo);
    if (!productNo.ok) {
      messages.push({ field: "productNo", message: productNo.message });
    }
    for (const key of FILTER_KEYS) {
      const parsed = parseNumberList(values.filters[key]);
      if (!parsed.ok) {
        messages.push({ field: `filters.${key}`, message: parsed.message });
      }
    }

    const result = productInputSchema.safeParse(
      toProductInput(values, magneticTrackIds),
    );
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = formFieldForPath(issue.path) ?? "root";
        const message =
          field === "root"
            ? labelled({
                field: issue.path.map(String).join("."),
                message: issue.message,
              })
            : issue.message;
        // The form's own check above has the friendlier message.
        if (!messages.some((m) => m.field === field)) {
          messages.push({ field, message });
        }
      }
    }

    if (messages.length === 0) return { values, errors: {} };
    const errors: Record<string, unknown> = {};
    for (const { field, message } of messages) {
      setPath(errors, field, { type: "validate", message });
    }
    return { values: {}, errors: errors as FieldErrors<ProductEditValues> };
  };
}
