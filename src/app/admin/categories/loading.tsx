// Loading state for the categories list: skeleton rows in the shape of the
// tree. Pages under it (new, edit) have their own form-shaped loading file.
// Renders no data, so no guard: the layout and the page check the admin.

import { Skeleton } from "@/components/ui/skeleton";

const PLACEHOLDER_ROWS = 6;

export default function CategoriesLoading() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-40" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
    </div>
  );
}
