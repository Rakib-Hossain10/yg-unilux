// The 403 page shown when requireAdmin() calls forbidden() for a signed-in
// user who isn't an active admin (ADR 0024). It says only "no access" and
// never which rule failed.

import type { Metadata } from "next";
import Link from "next/link";

import { SiteShell } from "@/components/site/site-shell";
import { StatusPage, statusAction } from "@/components/site/status-page";

export const metadata: Metadata = {
  title: "No access",
  robots: { index: false },
};

export default function Forbidden() {
  return (
    <SiteShell>
      <StatusPage
        code="403"
        title="No access"
        message="Your account doesn't have access to this page."
      >
        <Link href="/" className={statusAction}>
          Home
        </Link>
        <Link href="/login" className={statusAction}>
          Sign in with another account
        </Link>
      </StatusPage>
    </SiteShell>
  );
}
