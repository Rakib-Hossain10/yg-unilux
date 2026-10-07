// In-page link targets for publish reasons. A reason names a field; the link
// jumps to the control (or, for lists, the section) the admin must fix.

import { fieldId } from "./text-field";

/** Anchor id of a form section (variants list, images editor). */
export function sectionAnchor(name: string): string {
  return `product-section-${name}`;
}

/** The element id to link a publish reason to, or null when it has none. */
export function reasonTarget(field: string): string | null {
  switch (field) {
    case "variants":
    case "images":
      return sectionAnchor(field);
    case "mainCategory":
    case "datasheetId":
      return fieldId(field);
    default:
      return null;
  }
}
