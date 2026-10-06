"use client";

// Error boundary for the public pages (the "500"): the header and footer stay,
// the page body is replaced. In production Next sends only a generic error
// with a digest, never the server's message, and nothing more is shown here.

import Link from "next/link";

import { StatusPage, statusAction } from "@/components/site/status-page";

export default function SiteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <StatusPage
      code="Error"
      title="Something went wrong"
      message="Please try again. If the problem continues, contact us."
    >
      <button type="button" onClick={() => retry()} className={statusAction}>
        Try again
      </button>
      <Link href="/" className={statusAction}>
        Home
      </Link>
      {/* The digest matches the server log entry, without revealing details. */}
      {error.digest ? (
        <p className="w-full text-xs text-grey-500">
          Reference: {error.digest}
        </p>
      ) : null}
    </StatusPage>
  );
}
