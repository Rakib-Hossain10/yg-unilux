"use client";

// Error boundary for admin pages: the admin shell (header, nav) stays, the
// page body is replaced. Shows a fixed message and only the digest, which
// Next keeps generic in production; never the error's own message or stack.

import Link from "next/link";

import { ADMIN_HOME } from "@/components/admin/admin-sections";
import { Button } from "@/components/ui/button";

export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div role="alert" className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">
        This page could not be loaded. Try again. If it keeps failing, wait a
        minute and reload, then contact your developer.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={() => retry()}>
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link href={ADMIN_HOME}>Dashboard</Link>
        </Button>
      </div>
      {/* The digest matches the server log entry, without revealing details. */}
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          Reference: {error.digest}
        </p>
      ) : null}
    </div>
  );
}
