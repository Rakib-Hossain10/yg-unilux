// The datasheet button state on the product page (phase-4 plan, P7). Pure:
// derived from the datasheet access check (permissions.checkDatasheetAccess)
// and whether the product has a datasheet. Never carries a URL or key.

import type { DatasheetAccess } from "./permissions";

/**
 * - `download`: the viewer may download (links to /api/datasheet/<id>).
 * - `expired`: signed in, but access has run out or the account is blocked
 *   ("Access expired — contact us").
 * - `signin`: signed out, still on a temporary password, or not a
 *   customer/admin ("Sign in to download"; /login sends a temporary password
 *   on to /change-password).
 * - `coming-soon`: the product has no datasheet yet, for every viewer.
 */
export type DatasheetButtonState =
  "download" | "expired" | "signin" | "coming-soon";

export function datasheetButtonState(
  access: DatasheetAccess,
  hasDatasheet: boolean,
): DatasheetButtonState {
  if (!hasDatasheet) return "coming-soon";
  if (access.ok) return "download";
  switch (access.reason) {
    case "expired":
    case "banned":
      return "expired";
    case "signed-out":
    case "must-change-password":
    case "not-allowed":
      return "signin";
  }
}
