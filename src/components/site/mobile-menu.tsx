"use client";

// The small-screen menu: a native <details> disclosure (works without
// JavaScript), plus the closing behaviour a menu needs once the header stays
// mounted across pages: close on navigation, on Escape and on a click outside.

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

import { CloseIcon, MenuIcon } from "./icons";

export function MobileMenu({
  summaryClassName,
  children,
}: {
  summaryClassName: string;
  /** The menu panel (a <nav>), rendered on the server. */
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  // A client-side navigation keeps the (site) layout, so close it ourselves.
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;

    // Escape closes and hands focus back to the toggle (WAI-ARIA disclosure).
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !details.open) return;
      details.open = false;
      details.querySelector<HTMLElement>(":scope > summary")?.focus();
    };
    // A link inside the menu closes it, even when only the query changes
    // (the pathname effect above would not fire).
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (details.open && target?.closest("a[href]")) details.open = false;
    };
    // A press anywhere outside the open menu closes it.
    const onPointerDown = (event: PointerEvent) => {
      if (details.open && !details.contains(event.target as Node)) {
        details.open = false;
      }
    };

    details.addEventListener("keydown", onKeyDown);
    details.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      details.removeEventListener("keydown", onKeyDown);
      details.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return (
    <details
      ref={detailsRef}
      className="group lg:hidden"
      data-slot="mobile-menu"
    >
      <summary
        className={`${summaryClassName} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}
        aria-label="Menu"
      >
        <MenuIcon className="group-open:hidden" />
        <CloseIcon className="hidden group-open:block" />
      </summary>
      {children}
    </details>
  );
}
