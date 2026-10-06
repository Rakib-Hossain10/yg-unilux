"use client";

// One sidebar link that knows whether it is the current page. The only client
// part of the admin nav: it needs usePathname() because the admin layout (and
// so the nav) is not re-rendered on client-side navigation.

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
 * `exact` is for the dashboard (/admin), which would otherwise match every
 * admin page. Other links stay active on their sub-pages (/admin/products/42).
 */
function isCurrent(pathname: string | null, href: string, exact: boolean) {
  if (!pathname) return false;
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminNavLink({
  href,
  exact = false,
  children,
}: {
  href: string;
  exact?: boolean;
  children: ReactNode;
}) {
  const current = isCurrent(usePathname(), href, exact);

  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
        current
          ? "bg-muted font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
