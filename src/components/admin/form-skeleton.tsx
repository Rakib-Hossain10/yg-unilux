// Loading placeholder for an admin form page: a back link, a heading and a
// few label + input pairs. Shared by each module's new/edit loading.tsx.

import { Skeleton } from "@/components/ui/skeleton";

export function FormSkeleton({ fields = 4 }: { fields?: number }) {
  return (
    <div role="status" className="flex max-w-2xl flex-col gap-6">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-8 w-56" />
      </div>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8" />
        </div>
      ))}
    </div>
  );
}
