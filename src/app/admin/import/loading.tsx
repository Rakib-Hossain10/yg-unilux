// Loading state for the import page: skeletons in the shape of step 1.
// Renders no data, so no guard: the layout and the page check the admin.

import { Skeleton } from "@/components/ui/skeleton";

export default function ImportLoading() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-5 max-w-3xl" />
      <Skeleton className="h-72 max-w-2xl" />
    </div>
  );
}
