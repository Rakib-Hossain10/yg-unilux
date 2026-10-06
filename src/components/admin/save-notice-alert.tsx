// The success message shown at the top of an admin list page after a write
// redirected there (see save-notice.ts). A polite status, not an alert: it
// confirms what the admin just did and needs no interruption.

import { CircleCheck } from "lucide-react";

import { Alert, AlertTitle } from "@/components/ui/alert";

import type { SaveNotice } from "./save-notice";

export function SaveNoticeAlert({
  notice,
  messages,
}: {
  notice: SaveNotice | null;
  /** The text per notice, e.g. { created: "Category created." }. */
  messages: Record<SaveNotice, string>;
}) {
  if (notice === null) return null;
  return (
    <Alert role="status">
      <CircleCheck aria-hidden="true" />
      <AlertTitle>{messages[notice]}</AlertTitle>
    </Alert>
  );
}
