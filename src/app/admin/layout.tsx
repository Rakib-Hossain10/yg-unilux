// Admin shell for /admin (rule 3): skip link, header (wordmark, signed-in
// email, sign-out), sidebar nav and <main id="main">. requireAdmin() is the
// first statement, outside any Suspense, so a non-admin gets a real 403 (ADR
// 0024, 0029). Each page checks again: a layout doesn't re-run on client nav.

import type { Metadata } from "next";
import Link from "next/link";

import { AdminMobileMenu } from "@/components/admin/admin-mobile-menu";
import { AdminNav } from "@/components/admin/admin-nav";
import { ADMIN_HOME } from "@/components/admin/admin-sections";
import { SignOutButton } from "@/components/admin/sign-out-button";
import { requireAdmin } from "@/lib/permissions";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s | Admin | YG UniLUX" },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const viewer = await requireAdmin();

  return (
    <>
      {/* First focusable element: lets keyboard users jump past the nav. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-background px-4 md:px-6">
        <Link href={ADMIN_HOME} className="text-base font-semibold">
          YG UniLUX{" "}
          <span className="font-normal text-muted-foreground">Admin</span>
        </Link>
        <div className="flex min-w-0 items-center gap-4">
          <p className="hidden min-w-0 truncate text-sm text-muted-foreground sm:block">
            <span className="sr-only">Signed in as </span>
            {viewer.user.email}
          </p>
          <SignOutButton />
        </div>
      </header>

      <AdminMobileMenu>
        <AdminNav />
      </AdminMobileMenu>

      <div className="flex flex-1">
        <aside className="hidden w-60 shrink-0 border-r bg-background p-3 md:block">
          <AdminNav />
        </aside>
        <main id="main" className="min-w-0 flex-1 bg-background">
          <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
            {children}
          </div>
        </main>
      </div>
    </>
  );
}
