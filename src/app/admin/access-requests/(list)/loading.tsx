// Loading state for the access-request list: skeletons in the shape of the
// heading, the tabs and the table. In the (list) route group so it doesn't
// wrap [id]: the request page's not-found then answers a real 404 (gate A,
// L-1). Renders no data, so no guard: the layout and the page check the admin.

import { Skeleton } from "@/components/ui/skeleton";

const PLACEHOLDER_ROWS = 8;

export default function AccessRequestsLoading() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-9 w-56" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: PLACEHOLDER_ROWS }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    </div>
  );
}
