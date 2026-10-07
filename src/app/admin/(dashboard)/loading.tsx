// Loading state for the dashboard only: skeletons in its shape. In the
// (dashboard) route group so it no longer wraps every admin page: a page with
// no loading.tsx above it (product edit) can still answer a real 404 (L-1).

import { Skeleton } from "@/components/ui/skeleton";

const PLACEHOLDER_CARDS = 6;

export default function AdminLoading() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-40" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: PLACEHOLDER_CARDS }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
