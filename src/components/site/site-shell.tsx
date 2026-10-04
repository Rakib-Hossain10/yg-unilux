// The public page frame: skip link, header, main content and footer. Used by
// the (site) and (account) layouts and by the root 404 and 403 pages, which
// render outside any route group.

import type { ReactNode } from "react";

import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <>
      {/* First focusable element: lets keyboard users jump past the header. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-ink focus:px-4 focus:py-2 focus:text-paper"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="content" className="flex flex-1 flex-col">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
