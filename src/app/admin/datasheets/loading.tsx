// Loading state for the datasheets list: skeletons in the shape of the page.
// Renders no data, so no guard: the layout and the page check the admin.

import { Skeleton } from "@/components/ui/skeleton";

const PLACEHOLDER_ROWS = 6;

export default function DatasheetsLoading() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-36 max-w-2xl" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}
