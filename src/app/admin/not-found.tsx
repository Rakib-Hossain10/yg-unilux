// Shown inside the admin shell for any admin page that calls notFound() and
// has no more specific not-found.tsx. Static text only: it renders no data.

import Link from "next/link";

import { ADMIN_HOME } from "@/components/admin/admin-sections";
import { Button } from "@/components/ui/button";

export default function AdminNotFound() {
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-muted-foreground">
        This page does not exist. It may have been deleted or the address may be
        mistyped.
      </p>
      <Button asChild className="w-fit">
        <Link href={ADMIN_HOME}>Back to dashboard</Link>
      </Button>
    </div>
  );
}
