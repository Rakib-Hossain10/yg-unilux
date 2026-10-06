// Loading state for admin pages: skeletons in the shape of the dashboard.
// Next wraps the admin pages (not admin/layout.tsx) in Suspense with this, so
// the layout's requireAdmin() still runs before streaming and a 403 stays 403.

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
