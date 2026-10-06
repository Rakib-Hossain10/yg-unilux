// Layout for /admin (rule 3). requireAdmin() runs here for every full page
// load AND in each admin page, because a layout is not re-rendered on
// client-side navigation between its pages. Plain chrome; shadcn arrives in
// Phase 2. Called at the top, outside any Suspense, so a 403 stays a 403.

import type { Metadata } from "next";

import { SignOutButton } from "@/components/admin/sign-out-button";
import { requireAdmin } from "@/lib/permissions";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s | Admin | YG UniLUX" },
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const viewer = await requireAdmin();

  return (
    <div className="flex min-h-full flex-1 flex-col bg-grey-50">
      <header className="border-b border-grey-200 bg-paper">
        <div className="mx-auto flex h-14 max-w-(--container-site) items-center justify-between gap-4 px-4 md:px-8">
          <p className="font-display text-xl tracking-[0.12em]">
            YG UniLUX{" "}
            <span className="font-sans text-xs tracking-[0.16em] text-grey-600 uppercase">
              Admin
            </span>
          </p>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden text-grey-600 sm:inline">
              {viewer.user.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main
        id="content"
        className="mx-auto w-full max-w-(--container-site) flex-1 px-4 py-10 md:px-8"
      >
        {children}
      </main>
    </div>
  );
}
