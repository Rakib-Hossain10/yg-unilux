// Loading state for Settings: skeletons in the shape of the page.
// Renders no data, so no guard: the layout and the page check the admin.

import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div role="status" className="flex flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-40 max-w-2xl" />
      <Skeleton className="h-96 max-w-3xl" />
    </div>
  );
}
