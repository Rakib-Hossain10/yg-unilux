// Loading state for the new-area page: a form-shaped skeleton, so the list
// skeleton from the parent segment isn't shown for a form page.
// Renders no data, so no guard (the layout and the page check the admin).

import { FormSkeleton } from "@/components/admin/form-skeleton";

export default function NewAreaLoading() {
  return <FormSkeleton />;
}
