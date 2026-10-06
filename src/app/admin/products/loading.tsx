// Loading state for the products list: skeletons in the shape of the heading,
// the filter row and the table. The new page has its own form-shaped one.
// Renders no data, so no guard: the layout and the page check the admin.

import { Skeleton } from "@/components/ui/skeleton";

const PLACEHOLDER_ROWS = 10;

export default function ProductsLoading() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-14" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}
