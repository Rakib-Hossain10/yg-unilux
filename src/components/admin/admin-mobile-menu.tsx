"use client";

// Small-screen admin menu: a native <details> disclosure, so it opens and
// closes without JavaScript and with no animation. The one script here closes
// it after a link is followed, because the admin layout stays mounted.

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

export function AdminMobileMenu({ children }: { children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  // Close on every route change; nothing else is tracked (no React state).
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  // Also close when the current page's own link is tapped (no route change).
  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;
    const onClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        details.open = false;
      }
    };
    details.addEventListener("click", onClick);
    return () => details.removeEventListener("click", onClick);
  }, []);

  return (
    <details ref={detailsRef} className="group border-b md:hidden">
      <summary className="flex h-11 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <Menu aria-hidden="true" className="size-4" />
        Menu
      </summary>
      <div className="px-2 pb-3">{children}</div>
    </details>
  );
}
