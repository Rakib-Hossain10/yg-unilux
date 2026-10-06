// The site-wide 404 page, also used for routes that don't exist yet. It is
// outside any route group, so it brings the header and footer itself.

import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/site/site-shell";
import { StatusPage, statusAction } from "@/components/site/status-page";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <SiteShell>
      <StatusPage
        code="404"
        title="Page not found"
        message="The page you are looking for doesn't exist or has moved."
      >
        <Link href="/" className={statusAction}>
          Home
        </Link>
        <Link href="/products" className={statusAction}>
          Products
        </Link>
      </StatusPage>
    </SiteShell>
  );
}
